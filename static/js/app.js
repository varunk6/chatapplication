/**
 * VCHAT Client Application
 * Handles Real-time WebSockets, Presence, Typing Indicators, Attachments,
 * Voice/Video Call Simulation, Audio Chimes, Emoji Palette, Settings, and Mobile Layout.
 */

(function () {
    "use strict";

    // --- State Variables ---
    let currentUserId = null;
    let currentUsername = "";
    let currentDisplayName = "";
    let activeRoomId = null;
    let activeOtherUser = null;
    let chatSocket = null;
    let notifSocket = null;
    let typingTimeout = null;
    let isTyping = false;
    let editingMessageId = null;
    let pendingFile = null;
    let messageToDeleteId = null;
    let soundEnabled = localStorage.getItem("vchat_sound_enabled") !== "false";
    let patternEnabled = localStorage.getItem("vchat_pattern_enabled") !== "false";
    let oldestMessageId = null;
    let hasMoreMessages = false;
    let isLoadingEarlier = false;
    let notifReconnectTimeout = null;
    let chatReconnectTimeout = null;

    // Call Simulation State
    let callTimerInterval = null;
    let callDurationSec = 0;
    let isCallMuted = false;
    let isCallVideoOff = false;

    // --- Audio Synthesis for In-App Chime ---
    function playNotificationSound() {
        if (!soundEnabled) return;
        try {
            const ctx = new (window.AudioContext || window.webkitAudioContext)();
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.type = "sine";
            osc.frequency.setValueAtTime(587.33, ctx.currentTime); // D5
            osc.frequency.exponentialRampToValueAtTime(880, ctx.currentTime + 0.1); // A5
            gain.gain.setValueAtTime(0.12, ctx.currentTime);
            gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.35);
            osc.connect(gain);
            gain.connect(ctx.destination);
            osc.start();
            osc.stop(ctx.currentTime + 0.35);
        } catch (e) {
            // Audio context unsupported or user hasn't interacted
        }
    }

    // --- Toast Notifications ---
    function showToast(message, type = "info") {
        const container = document.getElementById("toast-container");
        if (!container) return;
        const toast = document.createElement("div");
        toast.className = `toast ${type}`;
        toast.innerHTML = `<span>${escapeHTML(message)}</span><button onclick="this.parentElement.remove()" style="background:none;border:none;cursor:pointer;color:inherit;font-size:16px;">×</button>`;
        container.appendChild(toast);
        setTimeout(() => {
            if (toast.parentElement) toast.remove();
        }, 4500);
    }

    // --- Utilities ---
    function getCSRFToken() {
        const cookieValue = document.cookie
            .split("; ")
            .find((row) => row.startsWith("csrftoken="))
            ?.split("=")[1];
        if (cookieValue) return cookieValue;
        const input = document.querySelector('[name=csrfmiddlewaretoken]');
        return input ? input.value : "";
    }

    function escapeHTML(str) {
        if (!str) return "";
        return str
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#039;");
    }

    function formatFileSize(bytes) {
        if (!bytes || bytes === 0) return "0 B";
        const k = 1024;
        const sizes = ["B", "KB", "MB", "GB"];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
    }

    // --- Theme Control ---
    window.setAppTheme = function (theme) {
        document.documentElement.setAttribute("data-theme", theme);
        localStorage.setItem("vchat_theme", theme);
        localStorage.setItem("chat_theme", theme);
        updateThemePreviewButtons(theme);
    };

    window.toggleTheme = function () {
        const current = document.documentElement.getAttribute("data-theme") || "light";
        const next = current === "dark" ? "light" : "dark";
        setAppTheme(next);
    };

    function updateThemePreviewButtons(theme) {
        const lightBtn = document.getElementById("theme-btn-light");
        const darkBtn = document.getElementById("theme-btn-dark");
        if (lightBtn) lightBtn.style.borderColor = theme === "light" ? "var(--brand-primary)" : "var(--border-subtle)";
        if (darkBtn) darkBtn.style.borderColor = theme === "dark" ? "var(--brand-primary)" : "var(--border-subtle)";
    }

    window.toggleWallpaperPattern = function (checkbox) {
        patternEnabled = checkbox.checked;
        localStorage.setItem("vchat_pattern_enabled", patternEnabled);
        const pattern = document.querySelector(".chat-bg-pattern");
        if (pattern) {
            pattern.style.display = patternEnabled ? "block" : "none";
        }
    };

    window.handleSoundSettingChange = function (checkbox) {
        soundEnabled = checkbox.checked;
        localStorage.setItem("vchat_sound_enabled", soundEnabled);
        const menuText = document.getElementById("menu-sound-text");
        if (menuText) {
            menuText.textContent = soundEnabled ? "Mute Notifications" : "Unmute Notifications";
        }
    };

    window.toggleSoundNotification = function () {
        soundEnabled = !soundEnabled;
        localStorage.setItem("vchat_sound_enabled", soundEnabled);
        const toggle = document.getElementById("setting-sound-toggle");
        if (toggle) toggle.checked = soundEnabled;
        const menuText = document.getElementById("menu-sound-text");
        if (menuText) {
            menuText.textContent = soundEnabled ? "Mute Notifications" : "Unmute Notifications";
        }
        showToast(soundEnabled ? "Notifications unmuted" : "Notifications muted", "info");
    };

    // --- Global Notifications & Presence WebSocket ---
    function connectNotificationSocket() {
        const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
        const url = `${protocol}//${window.location.host}/ws/notifications/`;

        if (notifSocket) {
            try { notifSocket.close(); } catch (e) { }
        }

        notifSocket = new WebSocket(url);

        notifSocket.onopen = function () {
            // Heartbeat ping every 30s
            setInterval(() => {
                if (notifSocket && notifSocket.readyState === WebSocket.OPEN) {
                    notifSocket.send(JSON.stringify({ type: "ping" }));
                }
            }, 30000);
        };

        notifSocket.onmessage = function (e) {
            try {
                const data = JSON.parse(e.data);
                if (data.type === "presence_update") {
                    handlePresenceUpdate(data);
                } else if (data.type === "conversation_updated") {
                    handleConversationUpdated(data);
                }
            } catch (err) {
                console.error("Error processing notification:", err);
            }
        };

        notifSocket.onclose = function () {
            clearTimeout(notifReconnectTimeout);
            notifReconnectTimeout = setTimeout(connectNotificationSocket, 3000);
        };
    }

    function handlePresenceUpdate(data) {
        // Update user status badge in conversation list
        const badges = document.querySelectorAll(`.conv-presence-${data.user_id}`);
        badges.forEach((b) => {
            if (data.is_online) b.classList.add("online");
            else b.classList.remove("online");
        });

        // Update header if chatting with this user
        if (activeOtherUser && activeOtherUser.id === data.user_id) {
            activeOtherUser.is_online = data.is_online;
            activeOtherUser.last_seen_display = data.last_seen_display;
            updateChatHeaderStatus(data.is_online, data.last_seen_display);
        }
    }

    function handleConversationUpdated(data) {
        loadConversationsList();
        const msg = data.last_message;
        if (msg && msg.room_id !== activeRoomId && !msg.is_mine) {
            playNotificationSound();
            showToast(`New message from ${msg.sender_display_name || msg.sender_username}: ${msg.text || msg.attachment_name || "Attachment"}`, "info");
        }
    }

    // --- Active Chat WebSocket ---
    function connectChatSocket(roomId) {
        if (chatSocket) {
            try { chatSocket.close(); } catch (e) { }
        }

        const banner = document.getElementById("connection-banner");
        if (banner) banner.classList.remove("hidden");

        const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
        const url = `${protocol}//${window.location.host}/ws/chat/${roomId}/`;

        chatSocket = new WebSocket(url);

        chatSocket.onopen = function () {
            if (banner) banner.classList.add("hidden");
            markRoomAsRead(roomId);
        };

        chatSocket.onmessage = function (e) {
            try {
                const data = JSON.parse(e.data);
                if (data.type === "chat_message") {
                    onReceiveChatMessage(data.message);
                } else if (data.type === "user_typing") {
                    onUserTypingEvent(data);
                } else if (data.type === "messages_read") {
                    onMessagesReadEvent(data);
                } else if (data.type === "message_edited") {
                    onMessageEditedEvent(data);
                } else if (data.type === "message_deleted") {
                    onMessageDeletedEvent(data);
                }
            } catch (err) {
                console.error("Error processing chat message:", err);
            }
        };

        chatSocket.onclose = function () {
            if (banner) banner.classList.remove("hidden");
            clearTimeout(chatReconnectTimeout);
            if (activeRoomId === roomId) {
                chatReconnectTimeout = setTimeout(() => connectChatSocket(roomId), 2500);
            }
        };
    }

    // --- Conversation List & Contacts Loading ---
    async function loadConversationsList() {
        const listEl = document.getElementById("conversations-list");
        if (!listEl) return;

        try {
            const res = await fetch("/api/conversations/");
            const data = await res.json();
            const conversations = data.conversations || [];

            let totalUnread = 0;
            conversations.forEach((c) => {
                totalUnread += c.unread_count || 0;
            });

            // Update badge in sidebar
            const unreadBadge = document.getElementById("nav-unread-total");
            if (unreadBadge) {
                if (totalUnread > 0) {
                    unreadBadge.textContent = totalUnread > 99 ? "99+" : totalUnread;
                    unreadBadge.classList.remove("hidden");
                } else {
                    unreadBadge.classList.add("hidden");
                }
            }

            if (conversations.length === 0) {
                listEl.innerHTML = `<div class="list-placeholder">No conversations yet.<br><br><button class="btn btn-secondary btn-sm" onclick="switchNavSection('contacts')">Start a conversation</button></div>`;
                return;
            }

            listEl.innerHTML = "";
            conversations.forEach((conv) => {
                const item = document.createElement("div");
                item.className = `conversation-item ${conv.room_id === activeRoomId ? "active" : ""}`;
                item.id = `conv-item-${conv.room_id}`;
                item.onclick = () => openConversation(conv.room_id, conv.other_user);

                const avatarHtml = conv.other_user.avatar_url
                    ? `<img src="${conv.other_user.avatar_url}" alt="${escapeHTML(conv.other_user.display_name)}" class="avatar-img">`
                    : `<div class="avatar-initial">${escapeHTML(conv.other_user.initial)}</div>`;

                const isOnlineClass = conv.other_user.is_online ? "online" : "";
                const lastMsg = conv.last_message;
                let snippet = "Tap to start conversation";
                let checkMark = "";

                if (lastMsg) {
                    if (lastMsg.is_mine) {
                        checkMark = lastMsg.status === "read" ? `<span class="read-status-icon read">✓✓</span> ` : `<span class="read-status-icon">✓</span> `;
                    }
                    snippet = escapeHTML(lastMsg.text || (lastMsg.attachment_name ? `📎 ${lastMsg.attachment_name}` : ""));
                }

                item.innerHTML = `
                    <div class="avatar-wrap">
                        ${avatarHtml}
                        <span class="presence-badge ${isOnlineClass} conv-presence-${conv.other_user.id}"></span>
                    </div>
                    <div class="conv-details">
                        <div class="conv-row-top">
                            <span class="conv-name">${escapeHTML(conv.other_user.display_name)}</span>
                            <span class="conv-time">${lastMsg ? lastMsg.time : ""}</span>
                        </div>
                        <div class="conv-row-bottom">
                            <span class="conv-last-msg">${checkMark}${snippet}</span>
                            ${conv.unread_count > 0 ? `<span class="unread-badge">${conv.unread_count}</span>` : ""}
                        </div>
                    </div>
                `;
                listEl.appendChild(item);
            });
        } catch (err) {
            console.error("Failed to load conversations:", err);
            listEl.innerHTML = `<div class="list-placeholder">Error loading conversations.</div>`;
        }
    }

    async function searchContacts(query = "") {
        const listEl = document.getElementById("contacts-list");
        if (!listEl) return;

        try {
            const res = await fetch(`/api/users/search/?q=${encodeURIComponent(query)}`);
            const data = await res.json();
            const users = data.users || [];

            if (users.length === 0) {
                listEl.innerHTML = `<div class="list-placeholder">No teammates found.</div>`;
                return;
            }

            listEl.innerHTML = "";
            users.forEach((u) => {
                const item = document.createElement("div");
                item.className = "conversation-item";
                item.onclick = () => startChatWithUser(u.username);

                const avatarHtml = u.avatar_url
                    ? `<img src="${u.avatar_url}" alt="${escapeHTML(u.display_name)}" class="avatar-img">`
                    : `<div class="avatar-initial">${escapeHTML(u.initial)}</div>`;

                item.innerHTML = `
                    <div class="avatar-wrap">
                        ${avatarHtml}
                        <span class="presence-badge ${u.is_online ? "online" : ""}"></span>
                    </div>
                    <div class="conv-details">
                        <div class="conv-row-top">
                            <span class="conv-name">${escapeHTML(u.display_name)}</span>
                            <span class="conv-time">@${escapeHTML(u.username)}</span>
                        </div>
                        <div class="conv-row-bottom">
                            <span class="conv-last-msg">${escapeHTML(u.bio || u.last_seen_display || "Available on VCHAT")}</span>
                        </div>
                    </div>
                `;
                listEl.appendChild(item);
            });
        } catch (err) {
            console.error("Failed to search users:", err);
            listEl.innerHTML = `<div class="list-placeholder">Failed to search users.</div>`;
        }
    }

    async function startChatWithUser(username) {
        try {
            const res = await fetch("/api/start-chat/", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "X-CSRFToken": getCSRFToken(),
                },
                body: JSON.stringify({ username: username }),
            });
            const data = await res.json();
            if (data.room_id) {
                switchSidebarTab("chats");
                await openConversation(data.room_id, data.other_user);
                loadConversationsList();
            } else if (data.error) {
                showToast(data.error, "error");
            }
        } catch (err) {
            showToast("Could not start conversation", "error");
        }
    }

    // --- Active Chat Opening & Message History ---
    async function openConversation(roomId, otherUser) {
        activeRoomId = roomId;
        activeOtherUser = otherUser;
        oldestMessageId = null;
        hasMoreMessages = false;

        // UI state toggles
        const emptyState = document.getElementById("chat-empty-state");
        const activeShell = document.getElementById("chat-active-shell");
        const app = document.getElementById("chat-app");

        if (emptyState) emptyState.classList.add("hidden");
        if (activeShell) activeShell.classList.remove("hidden");
        if (app) app.classList.add("mobile-chat-open");

        // Set active highlight on conversation item
        document.querySelectorAll(".conversation-item").forEach((el) => el.classList.remove("active"));
        const activeItem = document.getElementById(`conv-item-${roomId}`);
        if (activeItem) {
            activeItem.classList.add("active");
            const unread = activeItem.querySelector(".unread-badge");
            if (unread) unread.remove();
        }

        // Update header details
        updateChatHeader(otherUser);

        // Reset composer & attachments
        cancelEditMessage();
        removePendingAttachment();
        const textarea = document.getElementById("composer-textarea");
        if (textarea) textarea.value = "";
        updateSendButtonState();

        // Connect WebSocket for this room
        connectChatSocket(roomId);

        // Load messages history
        await loadMessagesHistory(roomId);
    }

    function updateChatHeader(otherUser) {
        const nameEl = document.getElementById("chat-header-name");
        const usernameEl = document.getElementById("chat-header-username");
        const avatarEl = document.getElementById("chat-header-avatar");
        const presenceDot = document.getElementById("chat-header-presence-dot");

        if (nameEl) nameEl.textContent = otherUser.display_name;
        if (usernameEl) usernameEl.textContent = `@${otherUser.username}`;

        if (avatarEl) {
            if (otherUser.avatar_url) {
                avatarEl.outerHTML = `<img id="chat-header-avatar" src="${otherUser.avatar_url}" alt="${escapeHTML(otherUser.display_name)}" class="avatar-img">`;
            } else {
                avatarEl.outerHTML = `<div id="chat-header-avatar" class="avatar-initial">${escapeHTML(otherUser.initial)}</div>`;
            }
        }

        if (presenceDot) {
            if (otherUser.is_online) {
                presenceDot.className = "presence-badge online";
            } else {
                presenceDot.className = "presence-badge";
            }
        }

        updateChatHeaderStatus(otherUser.is_online, otherUser.last_seen_display);
    }

    function updateChatHeaderStatus(isOnline, lastSeenStr) {
        const statusEl = document.getElementById("chat-header-status");
        if (!statusEl) return;
        if (statusEl.classList.contains("typing")) return;

        const label = statusEl.querySelector(".status-label");
        if (isOnline) {
            statusEl.className = "header-status-text";
            if (label) label.textContent = "Online";
        } else {
            statusEl.className = "header-status-text offline";
            if (label) label.textContent = lastSeenStr || "Offline";
        }
    }

    async function loadMessagesHistory(roomId, beforeId = null) {
        const feed = document.getElementById("messages-feed");
        const container = document.getElementById("messages-container");
        const loadMoreBtn = document.getElementById("load-earlier-wrap");

        if (!beforeId) {
            feed.innerHTML = `<div class="list-placeholder">Loading messages...</div>`;
        }

        try {
            let url = `/api/messages/?room_id=${roomId}`;
            if (beforeId) url += `&before_id=${beforeId}`;

            const res = await fetch(url);
            const data = await res.json();
            const messages = data.messages || [];

            hasMoreMessages = data.has_more;
            oldestMessageId = data.oldest_id;

            if (loadMoreBtn) {
                if (hasMoreMessages) loadMoreBtn.classList.remove("hidden");
                else loadMoreBtn.classList.add("hidden");
            }

            if (!beforeId) feed.innerHTML = "";

            if (messages.length === 0 && !beforeId) {
                feed.innerHTML = `<div class="list-placeholder">No messages yet. Send a message to say hello! 👋</div>`;
                return;
            }

            const previousScrollHeight = container.scrollHeight;

            if (beforeId) {
                const fragment = document.createDocumentFragment();
                let lastDate = "";
                messages.forEach((m) => {
                    if (m.created_date !== lastDate) {
                        fragment.appendChild(createDateDivider(m.created_date));
                        lastDate = m.created_date;
                    }
                    fragment.appendChild(createMessageRowElement(m));
                });
                feed.insertBefore(fragment, feed.firstChild);
                container.scrollTop = container.scrollHeight - previousScrollHeight;
            } else {
                let lastDate = "";
                messages.forEach((m) => {
                    if (m.created_date !== lastDate) {
                        feed.appendChild(createDateDivider(m.created_date));
                        lastDate = m.created_date;
                    }
                    feed.appendChild(createMessageRowElement(m));
                });
                scrollToBottom();
            }
        } catch (err) {
            console.error("Failed to load messages:", err);
            if (!beforeId) feed.innerHTML = `<div class="list-placeholder">Failed to load message history.</div>`;
        }
    }

    window.loadEarlierMessages = function () {
        if (!activeRoomId || !oldestMessageId || isLoadingEarlier) return;
        isLoadingEarlier = true;
        loadMessagesHistory(activeRoomId, oldestMessageId).finally(() => {
            isLoadingEarlier = false;
        });
    };

    function scrollToBottom() {
        const container = document.getElementById("messages-container");
        if (container) {
            container.scrollTop = container.scrollHeight;
        }
    }

    function createDateDivider(dateStr) {
        const div = document.createElement("div");
        div.className = "date-divider-row";
        div.innerHTML = `<span class="date-divider-pill">${escapeHTML(dateStr)}</span>`;
        return div;
    }

    // --- Message Rendering ---
    function createMessageRowElement(m) {
        const row = document.createElement("div");
        row.className = `message-row ${m.is_mine ? "mine" : "theirs"}`;
        row.id = `msg-row-${m.id}`;

        let statusIcon = "";
        if (m.is_mine) {
            if (m.status === "read") {
                statusIcon = `<span class="read-status-icon read" id="status-${m.id}" title="Read">✓✓</span>`;
            } else if (m.status === "delivered") {
                statusIcon = `<span class="read-status-icon" id="status-${m.id}" title="Delivered">✓✓</span>`;
            } else {
                statusIcon = `<span class="read-status-icon" id="status-${m.id}" title="Sent">✓</span>`;
            }
        }

        let attachmentHtml = "";
        if (m.attachment_url) {
            if (m.attachment_type === "image") {
                attachmentHtml = `
                    <div class="message-attachment">
                        <img src="${m.attachment_url}" alt="${escapeHTML(m.attachment_name || "Image")}" 
                             class="attachment-img-preview" onclick="openLightbox('${m.attachment_url}')">
                    </div>
                `;
            } else {
                attachmentHtml = `
                    <div class="message-attachment">
                        <div class="attachment-file-card">
                            <span class="file-card-icon">📄</span>
                            <div class="file-card-meta">
                                <div class="file-card-name" title="${escapeHTML(m.attachment_name)}">${escapeHTML(m.attachment_name)}</div>
                                <div class="file-card-size">${formatFileSize(m.attachment_size)}</div>
                            </div>
                            <a href="${m.attachment_url}" download class="file-download-btn" title="Download">⬇</a>
                        </div>
                    </div>
                `;
            }
        }

        let textHtml = "";
        if (m.is_deleted) {
            textHtml = `<div class="message-text deleted" id="msg-text-${m.id}">This message was deleted</div>`;
        } else if (m.text) {
            textHtml = `<div class="message-text" id="msg-text-${m.id}">${escapeHTML(m.text)}</div>`;
        }

        let actionsBtnHtml = "";
        if (!m.is_deleted) {
            actionsBtnHtml = `
                <button type="button" class="message-actions-btn" onclick="toggleMessageActions(event, ${m.id}, ${m.is_mine})" title="Message options">⋮</button>
            `;
        }

        row.innerHTML = `
            ${!m.is_mine ? `
                <div class="avatar-wrap small">
                    ${m.sender_avatar_url 
                        ? `<img src="${m.sender_avatar_url}" class="avatar-img" alt="${escapeHTML(m.sender_display_name)}">`
                        : `<div class="avatar-initial small">${escapeHTML(m.sender_initial)}</div>`
                    }
                </div>
            ` : ""}
            <div class="message-bubble">
                ${attachmentHtml}
                ${textHtml}
                <div class="message-meta">
                    ${m.is_edited && !m.is_deleted ? `<span class="edited-badge" id="msg-edited-${m.id}">(edited)</span>` : ""}
                    <span>${m.created_at}</span>
                    ${statusIcon}
                </div>
            </div>
            ${actionsBtnHtml}
        `;

        return row;
    }

    // --- Real-Time Events Handlers ---
    function onReceiveChatMessage(message) {
        if (message.room_id !== activeRoomId) return;

        const feed = document.getElementById("messages-feed");
        const placeholder = feed.querySelector(".list-placeholder");
        if (placeholder) placeholder.remove();

        const row = createMessageRowElement(message);
        feed.appendChild(row);
        scrollToBottom();

        if (!message.is_mine) {
            playNotificationSound();
            markRoomAsRead(activeRoomId);
        }
    }

    function onUserTypingEvent(data) {
        const typingRow = document.getElementById("chat-typing-indicator");
        const typingText = document.getElementById("typing-text");
        const headerStatus = document.getElementById("chat-header-status");

        if (data.is_typing) {
            if (typingRow) typingRow.classList.remove("hidden");
            if (typingText) typingText.textContent = `${data.username} is typing...`;
            if (headerStatus) {
                headerStatus.className = "header-status-text typing";
                const label = headerStatus.querySelector(".status-label");
                if (label) label.textContent = `${data.username} is typing...`;
            }
            scrollToBottom();
        } else {
            if (typingRow) typingRow.classList.add("hidden");
            if (headerStatus && activeOtherUser) {
                headerStatus.classList.remove("typing");
                updateChatHeaderStatus(activeOtherUser.is_online, activeOtherUser.last_seen_display);
            }
        }
    }

    function onMessagesReadEvent(data) {
        if (data.message_ids && Array.isArray(data.message_ids)) {
            data.message_ids.forEach((id) => {
                const icon = document.getElementById(`status-${id}`);
                if (icon) {
                    icon.className = "read-status-icon read";
                    icon.textContent = "✓✓";
                    icon.title = "Read";
                }
            });
        }
    }

    function onMessageEditedEvent(data) {
        const textEl = document.getElementById(`msg-text-${data.message_id}`);
        if (textEl) {
            textEl.textContent = data.text;
            const bubble = textEl.closest(".message-bubble");
            if (bubble && !bubble.querySelector(".edited-badge")) {
                const meta = bubble.querySelector(".message-meta");
                if (meta) {
                    const badge = document.createElement("span");
                    badge.className = "edited-badge";
                    badge.textContent = "(edited)";
                    meta.insertBefore(badge, meta.firstChild);
                }
            }
        }
    }

    function onMessageDeletedEvent(data) {
        const row = document.getElementById(`msg-row-${data.message_id}`);
        if (row) {
            const bubble = row.querySelector(".message-bubble");
            if (bubble) {
                const attachment = bubble.querySelector(".message-attachment");
                if (attachment) attachment.remove();
                const textEl = bubble.querySelector(".message-text");
                if (textEl) {
                    textEl.className = "message-text deleted";
                    textEl.textContent = "This message was deleted";
                }
                const edited = bubble.querySelector(".edited-badge");
                if (edited) edited.remove();
            }
            const actionBtn = row.querySelector(".message-actions-btn");
            if (actionBtn) actionBtn.remove();
        }
    }

    // --- Sending Messages & Typing ---
    window.handleSendMessage = async function (e) {
        if (e) e.preventDefault();
        if (!activeRoomId) return;

        const textarea = document.getElementById("composer-textarea");
        const text = textarea.value.trim();

        // If attachment is pending, upload via multipart
        if (pendingFile) {
            await uploadPendingAttachment(text);
            textarea.value = "";
            removePendingAttachment();
            updateSendButtonState();
            return;
        }

        // If editing
        if (editingMessageId) {
            await executeEditMessage(editingMessageId, text);
            cancelEditMessage();
            textarea.value = "";
            updateSendButtonState();
            return;
        }

        // Regular text send
        if (!text) return;

        if (chatSocket && chatSocket.readyState === WebSocket.OPEN) {
            chatSocket.send(JSON.stringify({
                action: "message",
                message: text,
            }));
            stopTyping();
            textarea.value = "";
            textarea.style.height = "auto";
            updateSendButtonState();
            textarea.focus();
        } else {
            showToast("Connecting to VCHAT... please try again", "error");
        }
    };

    function startTyping() {
        if (!isTyping && chatSocket && chatSocket.readyState === WebSocket.OPEN) {
            isTyping = true;
            chatSocket.send(JSON.stringify({ action: "typing_start" }));
        }
        clearTimeout(typingTimeout);
        typingTimeout = setTimeout(stopTyping, 2200);
    }

    function stopTyping() {
        if (isTyping && chatSocket && chatSocket.readyState === WebSocket.OPEN) {
            isTyping = false;
            chatSocket.send(JSON.stringify({ action: "typing_stop" }));
        }
        clearTimeout(typingTimeout);
    }

    async function markRoomAsRead(roomId) {
        try {
            await fetch("/api/mark-read/", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "X-CSRFToken": getCSRFToken(),
                },
                body: JSON.stringify({ room_id: roomId }),
            });
            if (chatSocket && chatSocket.readyState === WebSocket.OPEN) {
                chatSocket.send(JSON.stringify({ action: "mark_read" }));
            }
        } catch (e) { }
    }

    // --- Attachments & Uploads ---
    window.handleFileSelected = function (e) {
        const file = e.target.files[0];
        if (!file) return;

        if (file.size > 15 * 1024 * 1024) {
            showToast("File exceeds 15MB limit", "error");
            e.target.value = "";
            return;
        }

        pendingFile = file;
        const strip = document.getElementById("attachment-preview-strip");
        const nameEl = document.getElementById("attachment-chip-name");
        const sizeEl = document.getElementById("attachment-chip-size");
        const iconEl = document.getElementById("attachment-chip-icon");

        if (nameEl) nameEl.textContent = file.name;
        if (sizeEl) sizeEl.textContent = formatFileSize(file.size);
        if (iconEl) iconEl.textContent = file.type.startsWith("image/") ? "🖼" : "📎";
        if (strip) strip.classList.remove("hidden");

        updateSendButtonState();
    };

    window.removePendingAttachment = function () {
        pendingFile = null;
        const strip = document.getElementById("attachment-preview-strip");
        const fileInput = document.getElementById("composer-file-input");
        const imgInput = document.getElementById("composer-image-input");
        if (strip) strip.classList.add("hidden");
        if (fileInput) fileInput.value = "";
        if (imgInput) imgInput.value = "";
        updateSendButtonState();
    };

    async function uploadPendingAttachment(caption) {
        if (!pendingFile || !activeRoomId) return;

        const formData = new FormData();
        formData.append("room_id", activeRoomId);
        formData.append("file", pendingFile);
        formData.append("caption", caption);

        showToast("Uploading to VCHAT...", "info");

        try {
            const res = await fetch("/api/upload/", {
                method: "POST",
                headers: {
                    "X-CSRFToken": getCSRFToken(),
                },
                body: formData,
            });
            const data = await res.json();
            if (data.success) {
                showToast("Attachment sent", "success");
            } else {
                showToast(data.error || "Upload failed", "error");
            }
        } catch (err) {
            showToast("Upload failed", "error");
        }
    }

    // --- Message Actions: Copy, Edit, Delete ---
    window.toggleMessageActions = function (e, messageId, isMine) {
        e.stopPropagation();
        document.querySelectorAll(".message-actions-dropdown").forEach((el) => el.remove());

        const dropdown = document.createElement("div");
        dropdown.className = "message-actions-dropdown";

        const textEl = document.getElementById(`msg-text-${messageId}`);
        const currentText = textEl ? textEl.textContent : "";

        dropdown.innerHTML = `
            <button class="dropdown-action-btn" onclick="copyMessageText('${escapeHTML(currentText).replace(/'/g, "\\'")}')">Copy</button>
            ${isMine ? `
                <button class="dropdown-action-btn" onclick="initEditMessage(${messageId})">Edit</button>
                <button class="dropdown-action-btn danger" onclick="openDeleteModal(${messageId})">Delete</button>
            ` : ""}
        `;

        e.target.parentElement.appendChild(dropdown);

        const closeDropdown = () => {
            dropdown.remove();
            document.removeEventListener("click", closeDropdown);
        };
        setTimeout(() => document.addEventListener("click", closeDropdown), 0);
    };

    window.copyMessageText = function (text) {
        navigator.clipboard.writeText(text).then(() => {
            showToast("Message copied to clipboard", "info");
        });
    };

    window.initEditMessage = function (messageId) {
        const textEl = document.getElementById(`msg-text-${messageId}`);
        if (!textEl) return;
        editingMessageId = messageId;
        const textarea = document.getElementById("composer-textarea");
        textarea.value = textEl.textContent;
        textarea.focus();

        const editBar = document.getElementById("edit-mode-bar");
        const originalText = document.getElementById("edit-original-text");
        if (originalText) originalText.textContent = textEl.textContent;
        if (editBar) editBar.classList.remove("hidden");
        updateSendButtonState();
    };

    window.cancelEditMessage = function () {
        editingMessageId = null;
        const editBar = document.getElementById("edit-mode-bar");
        if (editBar) editBar.classList.add("hidden");
        updateSendButtonState();
    };

    async function executeEditMessage(messageId, newText) {
        try {
            if (chatSocket && chatSocket.readyState === WebSocket.OPEN) {
                chatSocket.send(JSON.stringify({
                    action: "edit_message",
                    message_id: messageId,
                    text: newText,
                }));
            } else {
                await fetch("/api/message-action/", {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        "X-CSRFToken": getCSRFToken(),
                    },
                    body: JSON.stringify({
                        action: "edit",
                        message_id: messageId,
                        text: newText,
                    }),
                });
            }
            showToast("Message updated", "success");
        } catch (err) {
            showToast("Failed to edit message", "error");
        }
    }

    window.openDeleteModal = function (messageId) {
        messageToDeleteId = messageId;
        const modal = document.getElementById("delete-modal");
        if (modal) modal.classList.remove("hidden");
    };

    window.closeDeleteModal = function () {
        messageToDeleteId = null;
        const modal = document.getElementById("delete-modal");
        if (modal) modal.classList.add("hidden");
    };

    window.executeDeleteMessage = async function () {
        if (!messageToDeleteId) return;
        const id = messageToDeleteId;
        closeDeleteModal();

        try {
            if (chatSocket && chatSocket.readyState === WebSocket.OPEN) {
                chatSocket.send(JSON.stringify({
                    action: "delete_message",
                    message_id: id,
                }));
            } else {
                await fetch("/api/message-action/", {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        "X-CSRFToken": getCSRFToken(),
                    },
                    body: JSON.stringify({
                        action: "delete",
                        message_id: id,
                    }),
                });
            }
            showToast("Message deleted", "info");
        } catch (err) {
            showToast("Failed to delete message", "error");
        }
    };

    // --- Search in Conversation ---
    window.toggleInChatSearch = function () {
        const bar = document.getElementById("in-chat-search-bar");
        if (!bar) return;
        bar.classList.toggle("hidden");
        if (!bar.classList.contains("hidden")) {
            const input = document.getElementById("chat-search-input");
            if (input) input.focus();
        } else {
            clearInChatSearchHighlight();
        }
    };

    function clearInChatSearchHighlight() {
        document.querySelectorAll(".search-highlight").forEach((span) => {
            const parent = span.parentNode;
            parent.replaceChild(document.createTextNode(span.textContent), span);
            parent.normalize();
        });
        const count = document.getElementById("chat-search-count");
        if (count) count.textContent = "0 matches";
    }

    function executeInChatSearch(query) {
        clearInChatSearchHighlight();
        if (!query.trim()) return;

        const countEl = document.getElementById("chat-search-count");
        let matches = 0;
        const regex = new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "gi");

        document.querySelectorAll(".message-text:not(.deleted)").forEach((el) => {
            const text = el.textContent;
            if (regex.test(text)) {
                matches++;
                el.innerHTML = escapeHTML(text).replace(regex, `<mark class="search-highlight">$1</mark>`);
            }
        });

        if (countEl) countEl.textContent = `${matches} match${matches === 1 ? "" : "es"}`;
    }

    // --- Emoji Picker ---
    const EMOJI_LIST = [
        "😀", "😃", "😄", "😁", "😆", "😅", "😂", "🤣", "😊", "😇",
        "🙂", "🙃", "😉", "😌", "😍", "🥰", "😘", "😗", "😙", "😚",
        "😋", "😛", "😜", "🤪", "😝", "🤑", "🤗", "🤭", "🤫", "🤔",
        "🤐", "🤨", "😐", "😑", "😶", "😏", "😒", "🙄", "😬", "😮",
        "👍", "👎", "👌", "✌️", "🤞", "🤟", "🤘", "🤙", "👏", "🙌",
        "❤️", "🧡", "💛", "💚", "💙", "💜", "🖤", "🤍", "💔", "🔥",
        "🎉", "✨", "🌟", "⭐", "🚀", "💡", "💯", "🎈", "🎁", "☕"
    ];

    function initEmojiPicker() {
        const grid = document.getElementById("emoji-grid");
        if (!grid) return;
        grid.innerHTML = "";
        EMOJI_LIST.forEach((emoji) => {
            const btn = document.createElement("span");
            btn.className = "emoji-item";
            btn.textContent = emoji;
            btn.onclick = () => insertEmoji(emoji);
            grid.appendChild(btn);
        });
    }

    window.toggleEmojiPicker = function () {
        const picker = document.getElementById("emoji-picker");
        if (picker) picker.classList.toggle("hidden");
    };

    function insertEmoji(emoji) {
        const textarea = document.getElementById("composer-textarea");
        if (!textarea) return;
        const start = textarea.selectionStart;
        const end = textarea.selectionEnd;
        const val = textarea.value;
        textarea.value = val.substring(0, start) + emoji + val.substring(end);
        textarea.selectionStart = textarea.selectionEnd = start + emoji.length;
        textarea.focus();
        updateSendButtonState();
    }

    // --- Lightbox Viewer ---
    window.openLightbox = function (imgUrl) {
        const modal = document.getElementById("image-lightbox");
        const img = document.getElementById("lightbox-img");
        const download = document.getElementById("lightbox-download");
        if (!modal || !img) return;
        img.src = imgUrl;
        if (download) download.href = imgUrl;
        modal.classList.remove("hidden");
    };

    window.closeLightbox = function () {
        const modal = document.getElementById("image-lightbox");
        if (modal) modal.classList.add("hidden");
    };

    // --- Left Sidebar Navigation Switcher ---
    window.switchNavSection = function (section) {
        document.querySelectorAll(".nav-menu-primary .nav-item").forEach((el) => el.classList.remove("active"));
        const btn = document.getElementById(`nav-btn-${section}`);
        if (btn) btn.classList.add("active");

        const heading = document.getElementById("panel-heading-text");

        if (section === "chats") {
            if (heading) heading.textContent = "Messages";
            switchSidebarTab("chats");
        } else if (section === "contacts") {
            if (heading) heading.textContent = "Contacts";
            switchSidebarTab("contacts");
        } else if (section === "profile") {
            openProfileModal();
        } else if (section === "settings") {
            openSettingsModal();
        }
    };

    window.switchSidebarTab = function (tab) {
        const tabChats = document.getElementById("tab-chats");
        const tabContacts = document.getElementById("tab-contacts");
        const paneChats = document.getElementById("conversations-pane");
        const paneContacts = document.getElementById("contacts-pane");
        const searchInput = document.getElementById("contact-search-input");

        if (tab === "chats") {
            if (tabChats) tabChats.classList.add("active");
            if (tabContacts) tabContacts.classList.remove("active");
            if (paneChats) paneChats.classList.remove("hidden");
            if (paneContacts) paneContacts.classList.add("hidden");
            if (searchInput) searchInput.placeholder = "Search users or messages...";
        } else {
            if (tabContacts) tabContacts.classList.add("active");
            if (tabChats) tabChats.classList.remove("active");
            if (paneContacts) paneContacts.classList.remove("hidden");
            if (paneChats) paneChats.classList.add("hidden");
            if (searchInput) {
                searchInput.placeholder = "Search teammates by name, username or email...";
                searchInput.focus();
            }
            searchContacts("");
        }
    };

    window.clearSearch = function () {
        const input = document.getElementById("contact-search-input");
        const clearBtn = document.getElementById("clear-search-btn");
        if (input) input.value = "";
        if (clearBtn) clearBtn.classList.add("hidden");
        loadConversationsList();
    };

    window.closeActiveChatMobile = function () {
        const app = document.getElementById("chat-app");
        if (app) app.classList.remove("mobile-chat-open");
    };

    function updateSendButtonState() {
        const textarea = document.getElementById("composer-textarea");
        const sendBtn = document.getElementById("composer-send-btn");
        if (!textarea || !sendBtn) return;
        const hasContent = textarea.value.trim().length > 0 || pendingFile !== null;
        sendBtn.disabled = !hasContent;
    }

    // --- Profile Modal & Avatar ---
    window.openProfileModal = function () {
        const modal = document.getElementById("profile-modal");
        if (modal) modal.classList.remove("hidden");
    };

    window.closeProfileModal = function () {
        const modal = document.getElementById("profile-modal");
        if (modal) modal.classList.add("hidden");
    };

    window.handleAvatarPreview = function (e) {
        const file = e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = function (evt) {
            const preview = document.getElementById("profile-avatar-preview");
            const initial = document.getElementById("profile-avatar-initial");
            if (preview) {
                preview.src = evt.target.result;
            } else if (initial) {
                initial.outerHTML = `<img id="profile-avatar-preview" src="${evt.target.result}" alt="Preview" class="avatar-img large">`;
            }
        };
        reader.readAsDataURL(file);
    };

    window.handleSaveProfile = async function (e) {
        e.preventDefault();
        const form = document.getElementById("profile-form");
        const formData = new FormData(form);

        const btn = document.getElementById("save-profile-btn");
        if (btn) btn.disabled = true;

        try {
            const res = await fetch("/api/profile/", {
                method: "POST",
                headers: {
                    "X-CSRFToken": getCSRFToken(),
                },
                body: formData,
            });
            const data = await res.json();
            if (data.success) {
                showToast("Profile updated successfully", "success");
                closeProfileModal();
                setTimeout(() => window.location.reload(), 600);
            } else {
                showToast("Failed to update profile", "error");
            }
        } catch (err) {
            showToast("Failed to update profile", "error");
        } finally {
            if (btn) btn.disabled = false;
        }
    };

    // --- Settings Modal ---
    window.openSettingsModal = function () {
        const modal = document.getElementById("settings-modal");
        if (modal) modal.classList.remove("hidden");

        const soundCheck = document.getElementById("setting-sound-toggle");
        if (soundCheck) soundCheck.checked = soundEnabled;

        const patternCheck = document.getElementById("setting-pattern-toggle");
        if (patternCheck) patternCheck.checked = patternEnabled;

        const currentTheme = document.documentElement.getAttribute("data-theme") || "light";
        updateThemePreviewButtons(currentTheme);
    };

    window.closeSettingsModal = function () {
        const modal = document.getElementById("settings-modal");
        if (modal) modal.classList.add("hidden");
    };

    // --- Recipient Profile Modal ---
    window.openRecipientProfile = function () {
        if (!activeOtherUser) return;
        const modal = document.getElementById("recipient-profile-modal");
        const nameEl = document.getElementById("recip-display-name");
        const handleEl = document.getElementById("recip-username");
        const statusEl = document.getElementById("recip-status-badge");
        const bioEl = document.getElementById("recip-bio-text");
        const avatarWrap = document.getElementById("recip-avatar-wrap");

        if (nameEl) nameEl.textContent = activeOtherUser.display_name;
        if (handleEl) handleEl.textContent = `@${activeOtherUser.username}`;
        if (statusEl) {
            statusEl.textContent = activeOtherUser.is_online ? "🟢 Online" : (activeOtherUser.last_seen_display || "Offline");
            statusEl.style.color = activeOtherUser.is_online ? "var(--status-online)" : "var(--text-muted)";
        }
        if (bioEl) bioEl.textContent = activeOtherUser.bio || "Available on VCHAT";

        if (avatarWrap) {
            if (activeOtherUser.avatar_url) {
                avatarWrap.innerHTML = `<img src="${activeOtherUser.avatar_url}" alt="${escapeHTML(activeOtherUser.display_name)}" class="avatar-img large">`;
            } else {
                avatarWrap.innerHTML = `<div class="avatar-initial large">${escapeHTML(activeOtherUser.initial)}</div>`;
            }
        }

        if (modal) modal.classList.remove("hidden");
    };

    window.closeRecipientProfile = function () {
        const modal = document.getElementById("recipient-profile-modal");
        if (modal) modal.classList.add("hidden");
    };

    // --- Voice & Video Call Experience ---
    window.startCall = function (type) {
        if (!activeOtherUser) return;
        const modal = document.getElementById("call-modal");
        const typeLabel = document.getElementById("call-type-label");
        const userName = document.getElementById("call-user-name");
        const statusLabel = document.getElementById("call-status-label");
        const timer = document.getElementById("call-timer");
        const avatarWrap = document.getElementById("call-avatar-wrap");

        if (typeLabel) typeLabel.textContent = type === "video" ? "VCHAT Video Call" : "VCHAT Voice Call";
        if (userName) userName.textContent = activeOtherUser.display_name;
        if (statusLabel) statusLabel.textContent = "Calling...";
        if (timer) timer.textContent = "00:00";

        if (avatarWrap) {
            if (activeOtherUser.avatar_url) {
                avatarWrap.innerHTML = `<img src="${activeOtherUser.avatar_url}" alt="${escapeHTML(activeOtherUser.display_name)}" class="avatar-img">`;
            } else {
                avatarWrap.innerHTML = `<div class="avatar-initial large">${escapeHTML(activeOtherUser.initial)}</div>`;
            }
        }

        if (modal) modal.classList.remove("hidden");

        // Simulate connection after 2 seconds
        callDurationSec = 0;
        clearInterval(callTimerInterval);
        setTimeout(() => {
            if (statusLabel) statusLabel.textContent = "Connected";
            callTimerInterval = setInterval(() => {
                callDurationSec++;
                const mins = String(Math.floor(callDurationSec / 60)).padStart(2, "0");
                const secs = String(callDurationSec % 60).padStart(2, "0");
                if (timer) timer.textContent = `${mins}:${secs}`;
            }, 1000);
        }, 2200);
    };

    window.toggleCallMute = function () {
        isCallMuted = !isCallMuted;
        const btn = document.getElementById("call-mute-btn");
        if (btn) btn.classList.toggle("active", isCallMuted);
        showToast(isCallMuted ? "Microphone muted" : "Microphone active", "info");
    };

    window.toggleCallVideo = function () {
        isCallVideoOff = !isCallVideoOff;
        const btn = document.getElementById("call-video-toggle-btn");
        if (btn) btn.classList.toggle("active", isCallVideoOff);
        showToast(isCallVideoOff ? "Camera turned off" : "Camera turned on", "info");
    };

    window.endCall = function () {
        clearInterval(callTimerInterval);
        const modal = document.getElementById("call-modal");
        if (modal) modal.classList.add("hidden");
        showToast("Call ended", "info");
    };

    window.closeCallModal = function () {
        endCall();
    };

    // --- Header Dropdown Menu ---
    window.toggleChatHeaderMenu = function (e) {
        e.stopPropagation();
        const menu = document.getElementById("chat-header-menu");
        if (menu) menu.classList.toggle("hidden");
    };

    window.clearLocalChatView = function () {
        const feed = document.getElementById("messages-feed");
        if (feed) feed.innerHTML = `<div class="list-placeholder">Screen cleared. New messages will appear here.</div>`;
        const menu = document.getElementById("chat-header-menu");
        if (menu) menu.classList.add("hidden");
        showToast("Chat view cleared", "info");
    };

    // --- DOMContentLoaded Initialization ---
    document.addEventListener("DOMContentLoaded", function () {
        // Read configuration from JSON script tags
        const userIdEl = document.getElementById("current-user-id");
        const usernameEl = document.getElementById("current-username");
        const displayNameEl = document.getElementById("current-display-name");
        const initialRoomIdEl = document.getElementById("initial-room-id");
        const targetUsernameEl = document.getElementById("initial-target-username");

        if (userIdEl) currentUserId = JSON.parse(userIdEl.textContent);
        if (usernameEl) currentUsername = JSON.parse(usernameEl.textContent);
        if (displayNameEl) currentDisplayName = JSON.parse(displayNameEl.textContent);

        let initialRoomId = initialRoomIdEl ? JSON.parse(initialRoomIdEl.textContent) : null;
        let initialTargetUsername = targetUsernameEl ? JSON.parse(targetUsernameEl.textContent) : null;

        // Apply saved background pattern
        const pattern = document.querySelector(".chat-bg-pattern");
        if (pattern) pattern.style.display = patternEnabled ? "block" : "none";

        // Start global presence & notifications WebSocket
        connectNotificationSocket();

        // Load initial conversations list
        loadConversationsList().then(() => {
            if (initialRoomId) {
                fetch("/api/conversations/").then((r) => r.json()).then((data) => {
                    const conv = (data.conversations || []).find((c) => c.room_id === initialRoomId);
                    if (conv) {
                        openConversation(conv.room_id, conv.other_user);
                    } else if (initialTargetUsername) {
                        startChatWithUser(initialTargetUsername);
                    }
                });
            } else if (initialTargetUsername) {
                startChatWithUser(initialTargetUsername);
            }
        });

        // Initialize Emoji Picker
        initEmojiPicker();

        // Composer Textarea Events (Auto-resize, Enter to send, Shift+Enter for new line)
        const textarea = document.getElementById("composer-textarea");
        if (textarea) {
            textarea.addEventListener("input", function () {
                this.style.height = "auto";
                this.style.height = Math.min(this.scrollHeight, 120) + "px";
                updateSendButtonState();
                startTyping();
            });

            textarea.addEventListener("keydown", function (e) {
                if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    handleSendMessage();
                }
            });
        }

        // Contact Search Input Debouncing
        const searchInput = document.getElementById("contact-search-input");
        const clearBtn = document.getElementById("clear-search-btn");
        let searchTimeout = null;

        if (searchInput) {
            searchInput.addEventListener("input", function () {
                const q = this.value.trim();
                if (clearBtn) {
                    if (q) clearBtn.classList.remove("hidden");
                    else clearBtn.classList.add("hidden");
                }

                clearTimeout(searchTimeout);
                searchTimeout = setTimeout(() => {
                    const contactsTabActive = document.getElementById("tab-contacts")?.classList.contains("active");
                    if (contactsTabActive) {
                        searchContacts(q);
                    } else {
                        // Filter conversations list live
                        const items = document.querySelectorAll("#conversations-list .conversation-item");
                        items.forEach((item) => {
                            const name = item.querySelector(".conv-name")?.textContent.toLowerCase() || "";
                            const snippet = item.querySelector(".conv-last-msg")?.textContent.toLowerCase() || "";
                            if (name.includes(q.toLowerCase()) || snippet.includes(q.toLowerCase())) {
                                item.style.display = "flex";
                            } else {
                                item.style.display = "none";
                            }
                        });
                    }
                }, 250);
            });
        }

        // In-Chat Search Input
        const inChatSearchInput = document.getElementById("chat-search-input");
        let inChatSearchTimeout = null;
        if (inChatSearchInput) {
            inChatSearchInput.addEventListener("input", function () {
                clearTimeout(inChatSearchTimeout);
                inChatSearchTimeout = setTimeout(() => {
                    executeInChatSearch(this.value);
                }, 200);
            });
        }

        // Close dropdowns on document click
        document.addEventListener("click", function (e) {
            const picker = document.getElementById("emoji-picker");
            const emojiToggle = document.getElementById("emoji-toggle-btn");
            if (picker && !picker.classList.contains("hidden")) {
                if (!picker.contains(e.target) && e.target !== emojiToggle) {
                    picker.classList.add("hidden");
                }
            }

            const headerMenu = document.getElementById("chat-header-menu");
            const moreBtn = document.getElementById("btn-chat-more");
            if (headerMenu && !headerMenu.classList.contains("hidden")) {
                if (!headerMenu.contains(e.target) && e.target !== moreBtn) {
                    headerMenu.classList.add("hidden");
                }
            }
        });
    });
})();
