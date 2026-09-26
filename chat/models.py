from django.contrib.auth.models import User
from django.db import models
from django.db.models.signals import post_save
from django.dispatch import receiver
from django.utils import timezone
from django.utils.timesince import timesince


class UserProfile(models.Model):
    user = models.OneToOneField(User, related_name="profile", on_delete=models.CASCADE)
    display_name = models.CharField(max_length=100, blank=True)
    avatar = models.ImageField(upload_to="avatars/%Y/%m/", blank=True, null=True)
    bio = models.TextField(max_length=300, blank=True)
    last_seen = models.DateTimeField(default=timezone.now)
    is_online = models.BooleanField(default=False)

    def __str__(self):
        return self.display_name or self.user.username

    @property
    def effective_name(self):
        return self.display_name.strip() if self.display_name else self.user.username

    @property
    def initial(self):
        name = self.effective_name
        return name[0].upper() if name else "U"

    @property
    def last_seen_display(self):
        if self.is_online:
            return "Online"
        if not self.last_seen:
            return "Offline"
        now = timezone.now()
        diff = now - self.last_seen
        if diff.total_seconds() < 60:
            return "Last seen just now"
        if diff.total_seconds() < 3600:
            minutes = int(diff.total_seconds() // 60)
            return f"Last seen {minutes}m ago"
        if diff.total_seconds() < 86400:
            hours = int(diff.total_seconds() // 3600)
            return f"Last seen {hours}h ago"
        return f"Last seen on {self.last_seen.strftime('%b %d')}"


@receiver(post_save, sender=User)
def create_or_update_user_profile(sender, instance, created, **kwargs):
    if created:
        UserProfile.objects.get_or_create(user=instance)
    else:
        if not hasattr(instance, "profile"):
            UserProfile.objects.get_or_create(user=instance)



class ChatRoom(models.Model):
    user1 = models.ForeignKey(User, related_name="rooms_as_user1", on_delete=models.CASCADE)
    user2 = models.ForeignKey(User, related_name="rooms_as_user2", on_delete=models.CASCADE)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=["user1", "user2"], name="unique_chat_pair")
        ]
        ordering = ["-updated_at"]

    def __str__(self):
        return f"{self.user1.username} - {self.user2.username}"

    def get_other_user(self, current_user):
        return self.user2 if current_user == self.user1 else self.user1

    def get_unread_count_for(self, user):
        try:
            read_state = self.read_states.get(user=user)
            if read_state.last_read_message_id:
                return self.messages.filter(id__gt=read_state.last_read_message_id).exclude(sender=user).count()
        except RoomReadState.DoesNotExist:
            pass
        return self.messages.exclude(sender=user).count()


class Message(models.Model):
    STATUS_CHOICES = (
        ("sent", "Sent"),
        ("delivered", "Delivered"),
        ("read", "Read"),
    )

    room = models.ForeignKey(ChatRoom, related_name="messages", on_delete=models.CASCADE)
    sender = models.ForeignKey(User, related_name="sent_messages", on_delete=models.CASCADE)
    text = models.TextField(blank=True, default="")
    attachment = models.FileField(upload_to="attachments/%Y/%m/%d/", blank=True, null=True)
    attachment_type = models.CharField(max_length=20, blank=True, null=True)  # 'image' | 'file'
    attachment_name = models.CharField(max_length=255, blank=True, null=True)
    attachment_size = models.PositiveIntegerField(default=0)  # in bytes
    is_edited = models.BooleanField(default=False)
    is_deleted = models.BooleanField(default=False)
    status = models.CharField(max_length=15, choices=STATUS_CHOICES, default="sent")
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["created_at"]
        indexes = [
            models.Index(fields=["room", "created_at"]),
        ]

    def __str__(self):
        sender_name = self.sender.username if self.sender else "Unknown"
        text_snippet = (self.text[:30] + "...") if len(self.text) > 30 else self.text
        return f"{sender_name}: {text_snippet or self.attachment_name or 'Attachment'}"


class RoomReadState(models.Model):
    room = models.ForeignKey(ChatRoom, related_name="read_states", on_delete=models.CASCADE)
    user = models.ForeignKey(User, related_name="chat_read_states", on_delete=models.CASCADE)
    last_read_message = models.ForeignKey(
        Message, null=True, blank=True, on_delete=models.SET_NULL, related_name="+"
    )
    last_read_at = models.DateTimeField(auto_now=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=["room", "user"], name="unique_room_user_read_state")
        ]

    def __str__(self):
        return f"{self.user.username} read {self.room} up to msg #{self.last_read_message_id}"

