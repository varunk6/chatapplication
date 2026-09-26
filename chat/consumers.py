import json
from collections import defaultdict
from channels.db import database_sync_to_async
from channels.generic.websocket import AsyncWebsocketConsumer
from django.contrib.auth.models import User
from django.utils import timezone

from .models import ChatRoom, Message, RoomReadState, UserProfile

# Thread-safe in-process tracking of active connections per user
# user_id -> set of channel names
USER_CONNECTIONS = defaultdict(set)


class NotificationConsumer(AsyncWebsocketConsumer):
    """
    Global WebSocket consumer for tracking user presence across multiple tabs,
    receiving cross-chat message notifications, and unread counts.
    """
    async def connect(self):
        self.user = self.scope.get("user")
        if not self.user or self.user.is_anonymous:
            await self.close()
            return

        self.user_id = self.user.id
        self.user_group = f"user_{self.user_id}"
        self.presence_group = "global_presence"

        USER_CONNECTIONS[self.user_id].add(self.channel_name)
        await self.channel_layer.group_add(self.user_group, self.channel_name)
        await self.channel_layer.group_add(self.presence_group, self.channel_name)

        await self.accept()

        # If this is the user's first active connection, mark online and broadcast
        if len(USER_CONNECTIONS[self.user_id]) == 1:
            await self.set_user_online_status(True)
            await self.channel_layer.group_send(
                self.presence_group,
                {
                    "type": "presence_update",
                    "user_id": self.user_id,
                    "username": self.user.username,
                    "is_online": True,
                    "last_seen_display": "Online",
                },
            )

    async def disconnect(self, close_code):
        if hasattr(self, "user_id") and self.user_id:
            USER_CONNECTIONS[self.user_id].discard(self.channel_name)
            await self.channel_layer.group_discard(self.user_group, self.channel_name)
            await self.channel_layer.group_discard(self.presence_group, self.channel_name)

            if len(USER_CONNECTIONS[self.user_id]) == 0:
                USER_CONNECTIONS.pop(self.user_id, None)
                last_seen_str = await self.set_user_online_status(False)
                await self.channel_layer.group_send(
                    self.presence_group,
                    {
                        "type": "presence_update",
                        "user_id": self.user_id,
                        "username": self.user.username,
                        "is_online": False,
                        "last_seen_display": last_seen_str,
                    },
                )

    async def receive(self, text_data):
        try:
            data = json.loads(text_data)
            msg_type = data.get("type")
            if msg_type == "ping":
                await self.send(text_data=json.dumps({"type": "pong"}))
        except (json.JSONDecodeError, TypeError):
            pass

    async def conversation_updated(self, event):
        await self.send(text_data=json.dumps({
            "type": "conversation_updated",
            "room_id": event.get("room_id"),
            "last_message": event.get("last_message"),
        }))

    async def presence_update(self, event):
        await self.send(text_data=json.dumps({
            "type": "presence_update",
            "user_id": event.get("user_id"),
            "username": event.get("username"),
            "is_online": event.get("is_online"),
            "last_seen_display": event.get("last_seen_display"),
        }))

    @database_sync_to_async
    def set_user_online_status(self, is_online):
        try:
            profile, _ = UserProfile.objects.get_or_create(user_id=self.user_id)
            profile.is_online = is_online
            profile.last_seen = timezone.now()
            profile.save(update_fields=["is_online", "last_seen"])
            return profile.last_seen_display
        except Exception:
            return "Offline"


class ChatConsumer(AsyncWebsocketConsumer):
    async def connect(self):
        self.user = self.scope.get("user")
        if not self.user or self.user.is_anonymous:
            await self.close()
            return

        self.room_id = self.scope["url_route"]["kwargs"]["room_id"]
        self.group_name = f"chat_{self.room_id}"

        allowed = await self.user_can_access_room()
        if not allowed:
            await self.close()
            return

        await self.channel_layer.group_add(self.group_name, self.channel_name)
        await self.accept()

    async def disconnect(self, close_code):
        if hasattr(self, "group_name"):
            # Broadcast typing stop on disconnect if they were typing
            await self.channel_layer.group_send(
                self.group_name,
                {
                    "type": "user_typing",
                    "username": self.user.username,
                    "is_typing": False,
                },
            )
            await self.channel_layer.group_discard(self.group_name, self.channel_name)

    async def receive(self, text_data):
        try:
            data = json.loads(text_data)
        except (json.JSONDecodeError, TypeError):
            return

        action = data.get("action")

        if action == "message":
            raw_text = data.get("message", "").strip()
            if not raw_text:
                return

            message_data = await self.save_message(raw_text)
            if message_data:
                # Send to room
                await self.channel_layer.group_send(
                    self.group_name,
                    {
                        "type": "chat_message",
                        "message": message_data,
                    },
                )
                # Send to both users' notification channels
                room_members = await self.get_room_members()
                for member_id in room_members:
                    await self.channel_layer.group_send(
                        f"user_{member_id}",
                        {
                            "type": "conversation_updated",
                            "room_id": int(self.room_id),
                            "last_message": message_data,
                        },
                    )

        elif action == "typing_start":
            await self.channel_layer.group_send(
                self.group_name,
                {
                    "type": "user_typing",
                    "username": self.user.username,
                    "is_typing": True,
                },
            )

        elif action == "typing_stop":
            await self.channel_layer.group_send(
                self.group_name,
                {
                    "type": "user_typing",
                    "username": self.user.username,
                    "is_typing": False,
                },
            )

        elif action == "mark_read":
            updated_ids = await self.mark_messages_read()
            if updated_ids:
                await self.channel_layer.group_send(
                    self.group_name,
                    {
                        "type": "messages_read",
                        "room_id": int(self.room_id),
                        "reader_username": self.user.username,
                        "message_ids": updated_ids,
                    },
                )

        elif action == "edit_message":
            msg_id = data.get("message_id")
            new_text = data.get("text", "").strip()
            if msg_id and new_text:
                success = await self.edit_message(msg_id, new_text)
                if success:
                    await self.channel_layer.group_send(
                        self.group_name,
                        {
                            "type": "message_edited",
                            "room_id": int(self.room_id),
                            "message_id": msg_id,
                            "text": new_text,
                            "is_edited": True,
                        },
                    )

        elif action == "delete_message":
            msg_id = data.get("message_id")
            if msg_id:
                success = await self.delete_message(msg_id)
                if success:
                    await self.channel_layer.group_send(
                        self.group_name,
                        {
                            "type": "message_deleted",
                            "room_id": int(self.room_id),
                            "message_id": msg_id,
                            "text": "This message was deleted",
                            "is_deleted": True,
                        },
                    )

    # Event handlers broadcasted to the group
    async def chat_message(self, event):
        await self.send(text_data=json.dumps({
            "type": "chat_message",
            "message": event["message"],
        }))

    async def user_typing(self, event):
        if event["username"] != self.user.username:
            await self.send(text_data=json.dumps({
                "type": "user_typing",
                "username": event["username"],
                "is_typing": event["is_typing"],
            }))

    async def messages_read(self, event):
        await self.send(text_data=json.dumps({
            "type": "messages_read",
            "room_id": event["room_id"],
            "reader_username": event["reader_username"],
            "message_ids": event["message_ids"],
        }))

    async def message_edited(self, event):
        await self.send(text_data=json.dumps({
            "type": "message_edited",
            "room_id": event["room_id"],
            "message_id": event["message_id"],
            "text": event["text"],
            "is_edited": event["is_edited"],
        }))

    async def message_deleted(self, event):
        await self.send(text_data=json.dumps({
            "type": "message_deleted",
            "room_id": event["room_id"],
            "message_id": event["message_id"],
            "text": event["text"],
            "is_deleted": event["is_deleted"],
        }))

    @database_sync_to_async
    def user_can_access_room(self):
        try:
            room = ChatRoom.objects.get(id=self.room_id)
            return self.user.id in (room.user1_id, room.user2_id)
        except ChatRoom.DoesNotExist:
            return False

    @database_sync_to_async
    def get_room_members(self):
        try:
            room = ChatRoom.objects.get(id=self.room_id)
            return [room.user1_id, room.user2_id]
        except ChatRoom.DoesNotExist:
            return []

    @database_sync_to_async
    def save_message(self, text):
        try:
            room = ChatRoom.objects.get(id=self.room_id)
            msg = Message.objects.create(room=room, sender=self.user, text=text, status="sent")
            room.updated_at = timezone.now()
            room.save(update_fields=["updated_at"])

            profile = getattr(self.user, "profile", None)
            display_name = profile.effective_name if profile else self.user.username
            avatar_url = profile.avatar.url if profile and profile.avatar else None
            initial = profile.initial if profile else (self.user.username[0].upper() if self.user.username else "U")

            return {
                "id": msg.id,
                "room_id": room.id,
                "sender_id": self.user.id,
                "sender_username": self.user.username,
                "sender_display_name": display_name,
                "sender_avatar_url": avatar_url,
                "sender_initial": initial,
                "text": msg.text,
                "attachment_url": None,
                "attachment_type": None,
                "attachment_name": None,
                "attachment_size": 0,
                "is_edited": False,
                "is_deleted": False,
                "status": msg.status,
                "created_at": msg.created_at.strftime("%H:%M"),
                "created_date": msg.created_at.strftime("%b %d, %Y"),
                "iso_created_at": msg.created_at.isoformat(),
            }
        except Exception:
            return None

    @database_sync_to_async
    def mark_messages_read(self):
        try:
            room = ChatRoom.objects.get(id=self.room_id)
            last_msg = room.messages.last()
            if last_msg:
                state, _ = RoomReadState.objects.get_or_create(room=room, user=self.user)
                state.last_read_message = last_msg
                state.save(update_fields=["last_read_message", "last_read_at"])

            unread = room.messages.filter(status__in=["sent", "delivered"]).exclude(sender=self.user)
            updated_ids = list(unread.values_list("id", flat=True))
            if updated_ids:
                unread.update(status="read")
            return updated_ids
        except Exception:
            return []

    @database_sync_to_async
    def edit_message(self, message_id, new_text):
        try:
            msg = Message.objects.get(id=message_id, room_id=self.room_id, sender=self.user)
            msg.text = new_text
            msg.is_edited = True
            msg.save(update_fields=["text", "is_edited", "updated_at"])
            return True
        except Message.DoesNotExist:
            return False

    @database_sync_to_async
    def delete_message(self, message_id):
        try:
            msg = Message.objects.get(id=message_id, room_id=self.room_id, sender=self.user)
            msg.is_deleted = True
            msg.text = "This message was deleted"
            if msg.attachment:
                msg.attachment.delete(save=False)
                msg.attachment = None
                msg.attachment_name = ""
                msg.attachment_size = 0
                msg.attachment_type = None
            msg.save()
            return True
        except Message.DoesNotExist:
            return False

