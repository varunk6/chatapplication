from django.contrib.auth import views as auth_views
from django.urls import path
from . import views

urlpatterns = [
    path("", views.home, name="home"),
    path("register/", views.register_view, name="register"),
    path("login/", auth_views.LoginView.as_view(template_name="login.html"), name="login"),
    path("logout/", views.logout_view, name="logout"),
    path("chat/<str:username>/", views.chat_room, name="chat_room"),

    # REST APIs for SPA chat
    path("api/conversations/", views.api_conversations, name="api_conversations"),
    path("api/messages/", views.api_messages, name="api_messages"),
    path("api/users/search/", views.api_search_users, name="api_search_users"),
    path("api/start-chat/", views.api_start_chat, name="api_start_chat"),
    path("api/upload/", views.api_upload_file, name="api_upload_file"),
    path("api/profile/", views.api_profile, name="api_profile"),
    path("api/message-action/", views.api_message_action, name="api_message_action"),
    path("api/mark-read/", views.api_mark_read, name="api_mark_read"),
]

