from django.contrib import admin
from .models import ChatRoom, Message, RoomReadState, UserProfile


@admin.register(UserProfile)
class UserProfileAdmin(admin.ModelAdmin):
    list_display = ("id", "user", "display_name", "is_online", "last_seen")
    search_fields = ("user__username", "user__email", "display_name")
    list_filter = ("is_online",)


@admin.register(ChatRoom)
class ChatRoomAdmin(admin.ModelAdmin):
    list_display = ("id", "user1", "user2", "created_at", "updated_at")
    search_fields = ("user1__username", "user2__username")
    list_filter = ("created_at", "updated_at")


@admin.register(Message)
class MessageAdmin(admin.ModelAdmin):
    list_display = (
        "id",
        "room",
        "sender",
        "text",
        "attachment_type",
        "status",
        "is_edited",
        "is_deleted",
        "created_at",
    )
    search_fields = ("text", "sender__username", "attachment_name")
    list_filter = ("status", "attachment_type", "is_edited", "is_deleted", "created_at")


@admin.register(RoomReadState)
class RoomReadStateAdmin(admin.ModelAdmin):
    list_display = ("id", "room", "user", "last_read_message", "last_read_at")
    search_fields = ("user__username",)

