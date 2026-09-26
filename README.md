<<<<<<< HEAD
# VCHAT — Professional Modern Messaging Platform

VCHAT is a professional, high-performance real-time messaging application built with Django and Django Channels. It features a modern 3-part messaging layout (Dark Navy navigation sidebar, conversation stream list, and spacious active chat area), instant WebSocket messaging, online presence tracking, typing indicators, read receipts, and voice/video calling integration.

## Key Features

- **Branding**: Full modern VCHAT brand identity with custom geometric V vector logos.
- **Three-Part Layout**:
  - **Left**: Dark navy sidebar with quick navigation (Chats, Contacts, Profile, Settings), theme switcher, and logged-in user profile with online indicator.
  - **Middle**: Real-time conversation stream, search box (*"Search users or messages..."*), unread counters, and teammate discovery.
  - **Right**: Active chat header with user presence, voice/video call buttons, in-chat search, textured messaging canvas, and rounded composer.
- **Real-Time WebSockets**: Instant delivery via Django Channels without page reloads.
- **Live Typing & Presence**: Dynamic "Rahul Sharma is typing..." and real-time online/offline presence tracking across multiple tabs.
- **Read Receipts & Delivery**: Single check (✓) for sent, double check (✓✓) for delivered, and blue double check for read.
- **Message Management**: Edit own messages, delete own messages, copy message text, and search conversation history.
- **Rich Media & Attachments**: File attachments with size formatting, direct image uploads with full-screen lightbox preview.
- **Themes**: System & manual Dark Navy and Clean Light mode toggles with persistent `localStorage`.
- **Fully Responsive**: Fluid adaptation across desktop, tablet, and mobile (320px, 375px, 425px, 768px, 1024px, 1440px+).

---

## Quick Start (Windows)

Simply **double-click** [`start.bat`](file:///d:/full%20stack/django_chat_application/start.bat) or [`START_PROJECT.bat`](file:///d:/full%20stack/START_PROJECT.bat)! It will automatically:
1. Activate your virtual environment (`env`)
2. Run database migrations
3. Launch `http://127.0.0.1:8000/` in your default browser
4. Start the VCHAT development server

---

## Manual Installation

### Windows
```bash
python -m venv env
env\Scripts\activate
pip install -r requirements.txt
python manage.py migrate
python manage.py createsuperuser
python manage.py runserver
```

### macOS / Linux
```bash
python3 -m venv env
source env/bin/activate
pip install -r requirements.txt
python manage.py migrate
python manage.py createsuperuser
python manage.py runserver
```

Open:
[http://127.0.0.1:8000/](http://127.0.0.1:8000/)

---

## Testing Real-Time Messaging

1. Register User A in your regular browser.
2. Open an incognito / private browser window.
3. Register User B.
4. Select or search for the other user from the **Contacts** tab.
5. Send messages back and forth:
   - Notice the instant WebSocket delivery
   - Check the typing indicator as you type
   - Verify unread counters update in real time
   - Test voice / video call modal controls
   - Test message edit and deletion
=======
# chatapplication
>>>>>>> 513359e38c068b3c2137f70059abe102d490bfc7
