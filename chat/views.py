import json
import mimetypes
import os
from asgiref.sync import async_to_sync
from channels.layers import get_channel_layer
from django.contrib.auth import login, logout
from django.contrib.auth.decorators import login_required
from django.contrib.auth.models import User
from django.core.paginator import Paginator
from django.db.models import Q
from django.http import JsonResponse
from django.shortcuts import get_object_or_404, redirect, render
from django.utils import timezone
from django.views.decorators.http import require_http_methods, require_POST

from .forms import ProfileUpdateForm, RegisterForm
from .models import ChatRoom, Message, RoomReadState, UserProfile

DANGEROUS_EXTENSIONS = {
    ".exe", ".bat", ".cmd", ".sh", ".bash", ".ps1", ".vbs", ".py", ".php",
    ".pl", ".cgi", ".jar", ".msi", ".com", ".scr", ".pif", ".wsf"
}
MAX_FILE_SIZE = 15 * 1024 * 1024  # 15MB


def register_view(request):
    if request.user.is_authenticated:
        return redirect("home")
    form = RegisterForm(request.POST or None)
    if request.method == "POST" and form.is_valid():
        user = form.save()
        login(request, user)
        return redirect("home")
    return render(request, "register.html", {"form": form})


def logout_view(request):
    if request.user.is_authenticated:
        profile = getattr(request.user, "profile", None)
        if profile:
            profile.is_online = False
            profile.last_seen = timezone.now()
            profile.save(update_fields=["is_online", "last_seen"])
    logout(request)
    return redirect("login")



def serialize_user_profile(user):
    profile, _ = UserProfile.objects.get_or_create(user=user)
    return {
        "id": user.id,
        "username": user.username,
        "display_name": profile.effective_name,
        "initial": profile.initial,
        "avatar_url": profile.avatar.url if profile.avatar else None,
        "is_online": profile.is_online,
        "last_seen_display": profile.last_seen_display,
        "bio": profile.bio,
    }


def serialize_message(message, current_user):
    sender = message.sender
    profile = getattr(sender, "profile", None)
    sender_initial = profile.initial if profile else (sender.username[0].upper() if sender.username else "U")
    sender_display_name = profile.effective_name if profile else sender.username
    sender_avatar_url = profile.avatar.url if profile and profile.avatar else None

    return {
        "id": message.id,
        "room_id": message.room_id,
        "sender_id": sender.id,
        "sender_username": sender.username,
        "sender_display_name": sender_display_name,
        "sender_avatar_url": sender_avatar_url,
        "sender_initial": sender_initial,
        "is_mine": sender.id == current_user.id,
        "text": message.text,
        "attachment_url": message.attachment.url if message.attachment else None,
        "attachment_type": message.attachment_type,
        "attachment_name": message.attachment_name,
        "attachment_size": message.attachment_size,
        "is_edited": message.is_edited,
        "is_deleted": message.is_deleted,
        "status": message.status,
        "created_at": message.created_at.strftime("%H:%M"),
        "created_date": message.created_at.strftime("%b %d, %Y"),
        "iso_created_at": message.created_at.isoformat(),
    }


@login_required
def home(request):
    profile, _ = UserProfile.objects.get_or_create(user=request.user)
    other_username = request.GET.get("user")
    initial_room = None
    target_user = None

    if other_username and other_username != request.user.username:
        try:
            target_user = User.objects.get(username=other_username)
            u1, u2 = sorted([request.user, target_user], key=lambda u: u.id)
            initial_room, _ = ChatRoom.objects.get_or_create(user1=u1, user2=u2)
        except User.DoesNotExist:
            pass

    return render(request, "home.html", {
        "profile": profile,
        "initial_room": initial_room,
        "target_user": target_user,
    })


@login_required
def chat_room(request, username):
    other = get_object_or_404(User, username=username)
    if other == request.user:
        return redirect("home")
    u1, u2 = sorted([request.user, other], key=lambda u: u.id)
    room, _ = ChatRoom.objects.get_or_create(user1=u1, user2=u2)
    profile, _ = UserProfile.objects.get_or_create(user=request.user)

    return render(request, "home.html", {
        "profile": profile,
        "initial_room": room,
        "target_user": other,
    })


@login_required
def api_conversations(request):
    rooms = ChatRoom.objects.filter(
        Q(user1=request.user) | Q(user2=request.user)
    ).select_related("user1__profile", "user2__profile").prefetch_related("messages")

    conversations = []
    for room in rooms:
        other_user = room.get_other_user(request.user)
        last_msg = room.messages.last()
        unread_count = room.get_unread_count_for(request.user)

        conversations.append({
            "room_id": room.id,
            "other_user": serialize_user_profile(other_user),
            "unread_count": unread_count,
            "updated_at": (last_msg.created_at if last_msg else room.created_at).isoformat(),
            "last_message": {
                "text": last_msg.text if last_msg else "",
                "attachment_name": last_msg.attachment_name if last_msg else "",
                "attachment_type": last_msg.attachment_type if last_msg else "",
                "sender_username": last_msg.sender.username if last_msg else "",
                "is_mine": last_msg.sender_id == request.user.id if last_msg else False,
                "status": last_msg.status if last_msg else "sent",
                "time": last_msg.created_at.strftime("%H:%M") if last_msg else "",
            } if last_msg else None,
        })

    conversations.sort(key=lambda x: x["updated_at"], reverse=True)
    return JsonResponse({"conversations": conversations})


@login_required
def api_messages(request):
    room_id = request.GET.get("room_id")
    before_id = request.GET.get("before_id")
    search = request.GET.get("search", "").strip()

    if not room_id:
        return JsonResponse({"error": "room_id required"}, status=400)

    try:
        room = ChatRoom.objects.get(id=room_id)
    except ChatRoom.DoesNotExist:
        return JsonResponse({"error": "Room not found"}, status=404)

    if request.user.id not in (room.user1_id, room.user2_id):
        return JsonResponse({"error": "Forbidden"}, status=403)

    qs = room.messages.select_related("sender", "sender__profile").order_by("-created_at")

    if search:
        qs = qs.filter(Q(text__icontains=search) | Q(attachment_name__icontains=search))

    if before_id:
        try:
            qs = qs.filter(id__lt=int(before_id))
        except ValueError:
            pass

    paginator = Paginator(qs, 40)
    page = paginator.get_page(1)
    messages_list = list(reversed(list(page.object_list)))

    return JsonResponse({
        "messages": [serialize_message(m, request.user) for m in messages_list],
        "has_more": page.has_next(),
        "oldest_id": messages_list[0].id if messages_list else None,
    })


@login_required
def api_search_users(request):
    query = request.GET.get("q", "").strip()
    users_qs = User.objects.exclude(id=request.user.id).select_related("profile")
    if query:
        users_qs = users_qs.filter(
            Q(username__icontains=query) |
            Q(profile__display_name__icontains=query) |
            Q(email__icontains=query)
        )
    users_qs = users_qs.order_by("username")[:25]

    results = []
    for u in users_qs:
        u1, u2 = sorted([request.user, u], key=lambda x: x.id)
        existing_room = ChatRoom.objects.filter(user1=u1, user2=u2).first()
        data = serialize_user_profile(u)
        data["room_id"] = existing_room.id if existing_room else None
        results.append(data)

    return JsonResponse({"users": results})


@login_required
@require_POST
def api_start_chat(request):
    try:
        data = json.loads(request.body.decode("utf-8"))
        username = data.get("username")
    except (json.JSONDecodeError, AttributeError):
        username = request.POST.get("username")

    if not username:
        return JsonResponse({"error": "Username is required"}, status=400)

    if username == request.user.username:
        return JsonResponse({"error": "Cannot chat with yourself"}, status=400)

    target_user = get_object_or_404(User, username=username)
    u1, u2 = sorted([request.user, target_user], key=lambda u: u.id)
    room, _ = ChatRoom.objects.get_or_create(user1=u1, user2=u2)

    return JsonResponse({
        "room_id": room.id,
        "other_user": serialize_user_profile(target_user),
    })


@login_required
@require_POST
def api_upload_file(request):
    room_id = request.POST.get("room_id")
    caption = request.POST.get("caption", "").strip()
    uploaded_file = request.FILES.get("file")

    if not room_id or not uploaded_file:
        return JsonResponse({"error": "File and room_id are required"}, status=400)

    try:
        room = ChatRoom.objects.get(id=room_id)
    except ChatRoom.DoesNotExist:
        return JsonResponse({"error": "Room not found"}, status=404)

    if request.user.id not in (room.user1_id, room.user2_id):
        return JsonResponse({"error": "Forbidden"}, status=403)

    if uploaded_file.size > MAX_FILE_SIZE:
        return JsonResponse({"error": f"File exceeds maximum allowed size of {MAX_FILE_SIZE // (1024 * 1024)}MB"}, status=400)

    _, ext = os.path.splitext(uploaded_file.name.lower())
    if ext in DANGEROUS_EXTENSIONS:
        return JsonResponse({"error": "This file type is not permitted for security reasons"}, status=400)

    content_type = uploaded_file.content_type or mimetypes.guess_type(uploaded_file.name)[0] or ""
    attachment_type = "image" if content_type.startswith("image/") else "file"

    msg = Message.objects.create(
        room=room,
        sender=request.user,
        text=caption,
        attachment=uploaded_file,
        attachment_type=attachment_type,
        attachment_name=uploaded_file.name,
        attachment_size=uploaded_file.size,
        status="sent",
    )
    room.updated_at = timezone.now()
    room.save(update_fields=["updated_at"])

    serialized = serialize_message(msg, request.user)

    channel_layer = get_channel_layer()
    if channel_layer:
        async_to_sync(channel_layer.group_send)(
            f"chat_{room.id}",
            {
                "type": "chat_message",
                "message": serialized,
            },
        )
        # Also notify personal notification channels of both users
        for uid in (room.user1_id, room.user2_id):
            async_to_sync(channel_layer.group_send)(
                f"user_{uid}",
                {
                    "type": "conversation_updated",
                    "room_id": room.id,
                    "last_message": serialized,
                },
            )

    return JsonResponse({"success": True, "message": serialized})


@login_required
@require_http_methods(["GET", "POST"])
def api_profile(request):
    profile, _ = UserProfile.objects.get_or_create(user=request.user)

    if request.method == "POST":
        form = ProfileUpdateForm(request.POST, request.FILES, instance=profile)
        if form.is_valid():
            form.save()
            return JsonResponse({
                "success": True,
                "profile": serialize_user_profile(request.user),
            })
        return JsonResponse({"success": False, "errors": form.errors}, status=400)

    return JsonResponse({
        "profile": serialize_user_profile(request.user),
        "email": request.user.email,
    })


@login_required
@require_POST
def api_message_action(request):
    try:
        data = json.loads(request.body.decode("utf-8"))
    except (json.JSONDecodeError, AttributeError):
        data = request.POST

    action = data.get("action")
    message_id = data.get("message_id")

    if not action or not message_id:
        return JsonResponse({"error": "action and message_id required"}, status=400)

    try:
        msg = Message.objects.select_related("room").get(id=message_id)
    except Message.DoesNotExist:
        return JsonResponse({"error": "Message not found"}, status=404)

    if msg.sender_id != request.user.id:
        return JsonResponse({"error": "You can only modify your own messages"}, status=403)

    channel_layer = get_channel_layer()

    if action == "edit":
        new_text = data.get("text", "").strip()
        if not new_text:
            return JsonResponse({"error": "Message text cannot be empty"}, status=400)
        msg.text = new_text
        msg.is_edited = True
        msg.save(update_fields=["text", "is_edited", "updated_at"])

        if channel_layer:
            async_to_sync(channel_layer.group_send)(
                f"chat_{msg.room_id}",
                {
                    "type": "message_edited",
                    "message_id": msg.id,
                    "room_id": msg.room_id,
                    "text": msg.text,
                    "is_edited": True,
                },
            )
        return JsonResponse({"success": True, "text": msg.text, "is_edited": True})

    elif action == "delete":
        msg.is_deleted = True
        msg.text = "This message was deleted"
        if msg.attachment:
            msg.attachment.delete(save=False)
            msg.attachment = None
            msg.attachment_name = ""
            msg.attachment_size = 0
            msg.attachment_type = None
        msg.save()

        if channel_layer:
            async_to_sync(channel_layer.group_send)(
                f"chat_{msg.room_id}",
                {
                    "type": "message_deleted",
                    "message_id": msg.id,
                    "room_id": msg.room_id,
                    "text": msg.text,
                    "is_deleted": True,
                },
            )
        return JsonResponse({"success": True, "message_id": msg.id, "is_deleted": True})

    return JsonResponse({"error": "Unknown action"}, status=400)


@login_required
@require_POST
def api_mark_read(request):
    try:
        data = json.loads(request.body.decode("utf-8"))
    except (json.JSONDecodeError, AttributeError):
        data = request.POST

    room_id = data.get("room_id")
    if not room_id:
        return JsonResponse({"error": "room_id required"}, status=400)

    try:
        room = ChatRoom.objects.get(id=room_id)
    except ChatRoom.DoesNotExist:
        return JsonResponse({"error": "Room not found"}, status=404)

    if request.user.id not in (room.user1_id, room.user2_id):
        return JsonResponse({"error": "Forbidden"}, status=403)

    last_msg = room.messages.last()
    if last_msg:
        state, _ = RoomReadState.objects.get_or_create(room=room, user=request.user)
        state.last_read_message = last_msg
        state.save(update_fields=["last_read_message", "last_read_at"])

        # Mark messages sent by the other user as 'read'
        unread_messages = room.messages.filter(status__in=["sent", "delivered"]).exclude(sender=request.user)
        updated_ids = list(unread_messages.values_list("id", flat=True))
        if updated_ids:
            unread_messages.update(status="read")

            channel_layer = get_channel_layer()
            if channel_layer:
                async_to_sync(channel_layer.group_send)(
                    f"chat_{room.id}",
                    {
                        "type": "messages_read",
                        "room_id": room.id,
                        "reader_username": request.user.username,
                        "message_ids": updated_ids,
                    },
                )

    return JsonResponse({"success": True, "unread_count": 0})

