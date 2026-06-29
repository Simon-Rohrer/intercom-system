import { WebSocket as UndiciWebSocket, } from "undici";
import { isCanvasAvailable, renderButtonImage } from "./imageRenderer.js";
/**
 * Manages WebSocket connection to Kesher backend for image streaming
 * and stores button images for use in feedbacks
 */
export class ImageBridge {
    instance;
    baseUrl;
    targetQuery;
    dispatcher;
    ws = null;
    reconnectTimer = null;
    reconnectAttempts = 0;
    maxReconnectAttempts = 10;
    baseReconnectDelay = 1000; // ms
    connected = false;
    lastError = "";
    lastMessageAt = 0;
    lastConnectAt = 0;
    lastDisconnectAt = 0;
    // Store images by slot and by composite bank/slot key.
    imageStorage = new Map();
    constructor(instance, baseUrl, targetQuery = "", dispatcher) {
        this.instance = instance;
        this.baseUrl = baseUrl;
        this.targetQuery = targetQuery;
        this.dispatcher = dispatcher;
    }
    /**
     * Connect to the Kesher image stream endpoint
     */
    connect() {
        if (this.ws?.readyState === WebSocket.OPEN) {
            return;
        }
        try {
            const wsUrl = this.baseUrl
                .replace(/^http/, "ws")
                .replace(/\/$/, "");
            const fullUrl = this.targetQuery
                ? `${wsUrl}/api/image-stream?${this.targetQuery}`
                : `${wsUrl}/api/image-stream`;
            this.instance.log("debug", `Connecting to image stream: ${fullUrl}`);
            this.ws = this.dispatcher
                ? new UndiciWebSocket(fullUrl, {
                    dispatcher: this.dispatcher,
                })
                : new UndiciWebSocket(fullUrl);
            this.ws.onopen = () => this.handleConnect();
            this.ws.onmessage = (event) => this.handleMessage(event);
            this.ws.onerror = (event) => this.handleError(event);
            this.ws.onclose = () => this.handleDisconnect();
        }
        catch (error) {
            this.instance.log("error", `Failed to create WebSocket: ${String(error)}`);
            this.scheduleReconnect();
        }
    }
    /**
     * Disconnect from the image stream
     */
    disconnect() {
        this.clearReconnectTimer();
        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }
        this.connected = false;
    }
    /**
     * Get stored image buffer for a slot, preferring the active page/bank.
     */
    getImage(slotIndex, pageNumber) {
        const rawSlot = Number.isFinite(slotIndex) ? Math.trunc(slotIndex) : -1;
        const slot = rawSlot >= 100 ? rawSlot % 100 : rawSlot;
        if (slot < 0)
            return undefined;
        const page = Number.isFinite(pageNumber) ? Math.trunc(pageNumber) : -1;
        if (page >= 0) {
            const pageScoped = this.imageStorage.get(page * 100 + slot);
            // When a page is known, never fall back to another page's slot image.
            return pageScoped;
        }
        // Preserve direct lookup for old feedback options that still store composite values.
        const rawDirect = this.imageStorage.get(rawSlot);
        if (rawDirect)
            return rawDirect;
        // Fallback for legacy feedback option storage by plain slot index.
        const direct = this.imageStorage.get(slot);
        if (direct)
            return direct;
        // Backward-compatible lookup for legacy composite key format.
        const legacy = this.imageStorage.get(100 + slot);
        if (legacy)
            return legacy;
        // Last-resort lookup for any composite key ending with this slot.
        for (const [key, value] of this.imageStorage.entries()) {
            if (key >= 100 && key % 100 === slot) {
                return value;
            }
        }
        return undefined;
    }
    /**
     * Clear all stored images
     */
    clearImages() {
        this.imageStorage.clear();
    }
    /**
     * Is connected to image stream
     */
    isConnected() {
        return this.connected;
    }
    /**
     * Return a short diagnostics snapshot for logs and variables.
     */
    getDiagnostics() {
        const state = this.ws?.readyState;
        const websocketState = state === WebSocket.OPEN
            ? "open"
            : state === WebSocket.CONNECTING
                ? "connecting"
                : state === WebSocket.CLOSING
                    ? "closing"
                    : state === WebSocket.CLOSED
                        ? "closed"
                        : "none";
        return {
            connected: this.connected,
            websocketState,
            reconnectAttempts: this.reconnectAttempts,
            lastError: this.lastError,
            lastMessageAt: this.lastMessageAt,
            lastConnectAt: this.lastConnectAt,
            lastDisconnectAt: this.lastDisconnectAt,
            storedImageCount: this.imageStorage.size,
        };
    }
    handleConnect() {
        this.connected = true;
        this.reconnectAttempts = 0;
        this.lastConnectAt = Date.now();
        this.lastError = "";
        this.instance.log("info", "Connected to Kesher image stream");
    }
    handleMessage(event) {
        try {
            this.lastMessageAt = Date.now();
            const message = JSON.parse(String(event.data));
            if (message.type === "update_button_image") {
                this.handleImageUpdate(message);
            }
        }
        catch (error) {
            this.instance.log("warn", `Failed to parse image message: ${String(error)}`);
        }
    }
    handleImageUpdate(message) {
        try {
            const bankNumber = Number.isFinite(Number(message.bank))
                ? Math.trunc(Number(message.bank))
                : 0;
            const rawButtonIndex = Number(message.buttonIndex);
            if (!Number.isFinite(rawButtonIndex)) {
                throw new Error("Invalid button index");
            }
            const buttonIndex = rawButtonIndex >= 100 ? rawButtonIndex % 100 : rawButtonIndex;
            const rawEffectValue = message.effectValue;
            if (rawEffectValue !== undefined && rawEffectValue !== null) {
                const effectValue = Number(rawEffectValue);
                if (Number.isFinite(effectValue)) {
                    this.instance.setButtonImageEffectValue(buttonIndex, effectValue, bankNumber);
                }
            }
            else {
                this.instance.setButtonImageEffectValue(buttonIndex, 0, bankNumber);
            }
            const buttonConfig = this.instance.getProfileButtonConfig(bankNumber, buttonIndex);
            // Prefer backend image payloads and only locally render when
            // metadata is known and canvas rendering is available.
            const state = String(message.state || "IDLE");
            const actionType = String(message.actionType || buttonConfig?.action?.type || "").trim();
            const roomId = String(buttonConfig?.action?.roomId || message.channel || "").trim();
            const isPartylineAction = actionType === "ptt_room" || actionType === "listen_room";
            const listeningFromPresence = isPartylineAction &&
                roomId !== "" &&
                this.instance.listenRooms.includes(roomId);
            const reportedListening = Boolean(message.isListening);
            const effectiveIsListening = reportedListening || listeningFromPresence;
            const label = actionType === "reply_to_caller" && this.instance.replyDirectUsername
                ? `Reply\n${this.instance.replyDirectUsername}`
                : String(message.label || message.channel || "").trim();
            const knownRenderableState = state === "IDLE" ||
                state === "TALK" ||
                state === "LISTEN" ||
                state === "BROADCAST";
            const canRenderLocally = knownRenderableState && isCanvasAvailable();
            const shouldForceReplyRender = actionType === "reply_to_caller" &&
                canRenderLocally &&
                this.instance.replyDirectUsername.trim() !== "";
            const shouldForceLocalRender = shouldForceReplyRender ||
                (isPartylineAction && canRenderLocally && listeningFromPresence !== reportedListening);
            let payloadImage = null;
            if (typeof message.imageBuffer === "string" && message.imageBuffer) {
                payloadImage = Buffer.from(message.imageBuffer, "base64");
            }
            else if (Buffer.isBuffer(message.imageBuffer)) {
                payloadImage = message.imageBuffer;
            }
            let imageBuffer;
            if (payloadImage && !shouldForceLocalRender) {
                imageBuffer = payloadImage;
            }
            else if (canRenderLocally) {
                const pressed = state === "TALK" || state === "BROADCAST";
                imageBuffer = renderButtonImage({
                    channel: String(message.channel || ""),
                    state,
                    label,
                    actionType,
                    color: String(message.color || ""),
                    isListening: effectiveIsListening,
                    pressed,
                    isActive: pressed,
                });
            }
            else if (payloadImage) {
                imageBuffer = payloadImage;
            }
            else {
                throw new Error("Invalid image buffer type");
            }
            // Always store page-scoped slot key to avoid cross-page overwrites.
            const compositeIndex = bankNumber * 100 + buttonIndex;
            this.imageStorage.set(compositeIndex, imageBuffer);
            // Keep plain slot storage only for legacy lookups where no page is known.
            this.imageStorage.set(buttonIndex, imageBuffer);
            // Preserve raw keys if upstream sends composite indices.
            if (rawButtonIndex !== buttonIndex) {
                this.imageStorage.set(rawButtonIndex, imageBuffer);
            }
            this.instance.log(buttonIndex === 0 ? "info" : "debug", `Stored image for button ${bankNumber}.${message.buttonIndex} -> slot ${buttonIndex} (${imageBuffer.length} bytes)`);
            // Trigger feedback update
            this.instance.checkFeedbacks("dynamic_button_image");
        }
        catch (error) {
            this.instance.log("error", `Failed to process image update: ${String(error)}`);
        }
    }
    handleError(event) {
        const maybeMessage = event && typeof event === "object" && "message" in event
            ? String(event.message ?? "")
            : "";
        if (maybeMessage) {
            this.lastError = maybeMessage;
            this.instance.log("error", `WebSocket error: ${maybeMessage}`);
        }
        else {
            this.lastError = "WebSocket error";
            this.instance.log("error", "WebSocket error");
        }
        this.scheduleReconnect();
    }
    handleDisconnect() {
        this.connected = false;
        this.lastDisconnectAt = Date.now();
        this.instance.log("warn", "Disconnected from Kesher image stream");
        this.scheduleReconnect();
    }
    scheduleReconnect() {
        if (this.reconnectAttempts >= this.maxReconnectAttempts) {
            this.instance.log("error", `Max reconnection attempts (${this.maxReconnectAttempts}) reached`);
            return;
        }
        this.clearReconnectTimer();
        const delay = this.baseReconnectDelay * Math.pow(2, this.reconnectAttempts);
        this.reconnectAttempts++;
        this.instance.log("info", `Reconnecting to image stream in ${delay}ms...`);
        this.reconnectTimer = setTimeout(() => {
            this.connect();
        }, delay);
    }
    clearReconnectTimer() {
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
    }
}
