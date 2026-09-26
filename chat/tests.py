import io
from django.contrib.auth.models import User
from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import Client, TestCase
from django.urls import reverse

from .models import ChatRoom, Message, RoomReadState, UserProfile


class ChatApplicationTests(TestCase):
    def setUp(self):
        self.client = Client()
        self.user1 = User.objects.create_user(
            username="alice",
            email="alice@example.com",
            password="testpassword123"
        )
        self.user2 = User.objects.create_user(
            username="bob",
            email="bob@example.com",
            password="testpassword123"
        )
        self.user3 = User.objects.create_user(
            username="charlie",
            email="charlie@example.com",
            password="testpassword123"
        )

    def test_user_profile_created_automatically(self):
        """Test that UserProfile is automatically created via post_save signal."""
        profile1 = UserProfile.objects.filter(user=self.user1).first()
        self.assertIsNotNone(profile1)
        self.assertEqual(profile1.effective_name, "alice")
        self.assertEqual(profile1.initial, "A")
        self.assertIn("just now", profile1.last_seen_display)

        # When marked online
        profile1.is_online = True
        profile1.save()
        self.assertEqual(profile1.last_seen_display, "Online")


    def test_registration_view(self):
        """Test user registration endpoint."""
        response = self.client.post(reverse("register"), {
            "username": "david",
            "display_name": "David Miller",
            "email": "david@example.com",
            "password1": "ComplexPwd99!",
            "password2": "ComplexPwd99!",
        })
        self.assertEqual(response.status_code, 302)  # redirects to home
        david = User.objects.filter(username="david").first()
        self.assertIsNotNone(david)
        self.assertEqual(david.profile.display_name, "David Miller")

    def test_start_chat_and_room_creation(self):
        """Test starting a private conversation between two users."""
        self.client.login(username="alice", password="testpassword123")
        response = self.client.post(
            reverse("api_start_chat"),
            data={"username": "bob"},
            content_type="application/json"
        )
        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertIn("room_id", data)
        self.assertEqual(data["other_user"]["username"], "bob")

        # Verify database room
        u1, u2 = sorted([self.user1, self.user2], key=lambda u: u.id)
        room = ChatRoom.objects.get(user1=u1, user2=u2)
        self.assertEqual(room.id, data["room_id"])

    def test_cannot_chat_with_self(self):
        """Test user cannot start a private conversation with themselves."""
        self.client.login(username="alice", password="testpassword123")
        response = self.client.post(
            reverse("api_start_chat"),
            data={"username": "alice"},
            content_type="application/json"
        )
        self.assertEqual(response.status_code, 400)

    def test_conversations_and_unread_counts(self):
        """Test conversation list API with message snippets and unread tracking."""
        u1, u2 = sorted([self.user1, self.user2], key=lambda u: u.id)
        room = ChatRoom.objects.create(user1=u1, user2=u2)

        # Bob sends message to Alice
        Message.objects.create(room=room, sender=self.user2, text="Hello Alice!")

        # Log in as Alice
        self.client.login(username="alice", password="testpassword123")
        response = self.client.get(reverse("api_conversations"))
        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertEqual(len(data["conversations"]), 1)
        conv = data["conversations"][0]
        self.assertEqual(conv["other_user"]["username"], "bob")
        self.assertEqual(conv["unread_count"], 1)
        self.assertEqual(conv["last_message"]["text"], "Hello Alice!")

    def test_message_retrieval_and_permissions(self):
        """Test messages retrieval and authorization checks."""
        u1, u2 = sorted([self.user1, self.user2], key=lambda u: u.id)
        room = ChatRoom.objects.create(user1=u1, user2=u2)
        Message.objects.create(room=room, sender=self.user1, text="Secret chat between Alice & Bob")

        # Charlie tries to view Alice & Bob's room
        self.client.login(username="charlie", password="testpassword123")
        response = self.client.get(reverse("api_messages") + f"?room_id={room.id}")
        self.assertEqual(response.status_code, 403)

        # Alice views the room
        self.client.login(username="alice", password="testpassword123")
        response = self.client.get(reverse("api_messages") + f"?room_id={room.id}")
        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertEqual(len(data["messages"]), 1)
        self.assertEqual(data["messages"][0]["text"], "Secret chat between Alice & Bob")
        self.assertTrue(data["messages"][0]["is_mine"])

    def test_message_actions_edit_and_delete(self):
        """Test edit and delete actions with ownership validation."""
        u1, u2 = sorted([self.user1, self.user2], key=lambda u: u.id)
        room = ChatRoom.objects.create(user1=u1, user2=u2)
        msg = Message.objects.create(room=room, sender=self.user1, text="Original text")

        # Bob tries to edit Alice's message -> should be forbidden
        self.client.login(username="bob", password="testpassword123")
        response = self.client.post(
            reverse("api_message_action"),
            data={"action": "edit", "message_id": msg.id, "text": "Hacked text"},
            content_type="application/json"
        )
        self.assertEqual(response.status_code, 403)

        # Alice edits her own message -> success
        self.client.login(username="alice", password="testpassword123")
        response = self.client.post(
            reverse("api_message_action"),
            data={"action": "edit", "message_id": msg.id, "text": "Edited text"},
            content_type="application/json"
        )
        self.assertEqual(response.status_code, 200)
        msg.refresh_from_db()
        self.assertEqual(msg.text, "Edited text")
        self.assertTrue(msg.is_edited)

        # Alice deletes her message
        response = self.client.post(
            reverse("api_message_action"),
            data={"action": "delete", "message_id": msg.id},
            content_type="application/json"
        )
        self.assertEqual(response.status_code, 200)
        msg.refresh_from_db()
        self.assertTrue(msg.is_deleted)
        self.assertEqual(msg.text, "This message was deleted")

    def test_file_upload_security(self):
        """Test safe file upload and dangerous extension rejection."""
        u1, u2 = sorted([self.user1, self.user2], key=lambda u: u.id)
        room = ChatRoom.objects.create(user1=u1, user2=u2)
        self.client.login(username="alice", password="testpassword123")

        # Try uploading dangerous .exe file
        bad_file = SimpleUploadedFile("malicious.exe", b"binary content", content_type="application/octet-stream")
        response = self.client.post(reverse("api_upload_file"), {
            "room_id": room.id,
            "file": bad_file,
            "caption": "malicious script",
        })
        self.assertEqual(response.status_code, 400)
        self.assertIn("not permitted", response.json().get("error", ""))

        # Upload safe text document
        good_file = SimpleUploadedFile("notes.txt", b"meeting notes content", content_type="text/plain")
        response = self.client.post(reverse("api_upload_file"), {
            "room_id": room.id,
            "file": good_file,
            "caption": "here are the notes",
        })
        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertTrue(data["success"])
        self.assertEqual(data["message"]["attachment_name"], "notes.txt")
        self.assertEqual(data["message"]["attachment_type"], "file")

    def test_profile_update(self):
        """Test updating profile information."""
        self.client.login(username="alice", password="testpassword123")
        response = self.client.post(reverse("api_profile"), {
            "display_name": "Alice Wonderland",
            "bio": "Coding in Python & Django",
            "email": "new_alice@example.com",
        })
        self.assertEqual(response.status_code, 200)
        self.user1.refresh_from_db()
        self.assertEqual(self.user1.profile.display_name, "Alice Wonderland")
        self.assertEqual(self.user1.profile.bio, "Coding in Python & Django")
        self.assertEqual(self.user1.email, "new_alice@example.com")


from channels.testing import WebsocketCommunicator
from .consumers import ChatConsumer, NotificationConsumer


class WebSocketConsumerTests(TestCase):
    async def test_notification_consumer_ping_pong(self):
        """Test global notification consumer connection, presence broadcast, and ping/pong."""
        user = await User.objects.acreate_user(username="ws_test_user", password="password123")
        communicator = WebsocketCommunicator(NotificationConsumer.as_asgi(), "/ws/notifications/")
        communicator.scope["user"] = user
        connected, _ = await communicator.connect()
        self.assertTrue(connected)

        # On initial connection, presence_update is broadcast
        first_msg = await communicator.receive_json_from()
        self.assertEqual(first_msg.get("type"), "presence_update")
        self.assertTrue(first_msg.get("is_online"))

        await communicator.send_json_to({"type": "ping"})
        response = await communicator.receive_json_from()
        self.assertEqual(response.get("type"), "pong")
        await communicator.disconnect()


    async def test_chat_consumer_message_exchange(self):
        """Test chat consumer sending and receiving message events."""
        u1 = await User.objects.acreate_user(username="ws_alice", password="password123")
        u2 = await User.objects.acreate_user(username="ws_bob", password="password123")
        room = await ChatRoom.objects.acreate(user1=u1, user2=u2)

        communicator = WebsocketCommunicator(ChatConsumer.as_asgi(), f"/ws/chat/{room.id}/")
        communicator.scope["user"] = u1
        communicator.scope["url_route"] = {"kwargs": {"room_id": str(room.id)}}
        connected, _ = await communicator.connect()
        self.assertTrue(connected)

        # Send chat message
        await communicator.send_json_to({"action": "message", "message": "Hello from WS test!"})
        response = await communicator.receive_json_from()
        self.assertEqual(response["type"], "chat_message")
        self.assertEqual(response["message"]["text"], "Hello from WS test!")
        self.assertEqual(response["message"]["sender_username"], "ws_alice")

        await communicator.disconnect()

