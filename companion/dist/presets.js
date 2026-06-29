import { combineRgb, } from "@companion-module/base";
function rgbFromNumber(color) {
    return {
        r: (color >> 16) & 0xff,
        g: (color >> 8) & 0xff,
        b: color & 0xff,
    };
}
export function parseButtonBgColor(color) {
    const value = (color || "").trim();
    if (!value)
        return combineRgb(0, 0, 0);
    const normalized = value.startsWith("#") ? value.slice(1) : value;
    const hex = normalized.length === 3
        ? normalized
            .split("")
            .map((char) => `${char}${char}`)
            .join("")
        : normalized;
    if (!/^[0-9a-fA-F]{6}$/.test(hex)) {
        return combineRgb(0, 0, 0);
    }
    return combineRgb(Number.parseInt(hex.slice(0, 2), 16), Number.parseInt(hex.slice(2, 4), 16), Number.parseInt(hex.slice(4, 6), 16));
}
export function deriveTextColor(bgcolor) {
    const { r, g, b } = rgbFromNumber(bgcolor);
    const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    return luminance > 0.6
        ? combineRgb(0, 0, 0)
        : combineRgb(255, 255, 255);
}
function singleLine(value) {
    return value.replace(/\s+/g, " ").trim();
}
function cleanLabel(value, fallback) {
    const label = singleLine(value);
    return label || fallback;
}
function presetIdPart(value) {
    return String(value)
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "")
        .slice(0, 48) || "item";
}
function rolePresetCategory(self, profile) {
    const roleLabel = cleanLabel(profile?.roleName ||
        profile?.roleId ||
        self.discovery.roleName ||
        self.discovery.roleId ||
        self.config.roleId ||
        "", "Unassigned role");
    const profileLabel = cleanLabel(profile?.username || self.discovery.username || self.config.username || "", "Default profile");
    return `Kesher / ${roleLabel} / ${profileLabel}`;
}
function pageLabel(page) {
    const title = singleLine(page.title || "");
    return title ? `Page ${page.page + 1} / ${title}` : `Page ${page.page + 1}`;
}
function profilePagePresetCategory(self, profile, page) {
    return `${rolePresetCategory(self, profile)} / ${pageLabel(page)}`;
}
function gridColumnCount(settings) {
    const columns = Math.trunc(Number(settings.gridColumns || 5));
    return Number.isFinite(columns) && columns > 0 ? Math.min(columns, 20) : 5;
}
function gridButtonCount(settings) {
    const rows = Math.trunc(Number(settings.gridRows || 3));
    const rowCount = Number.isFinite(rows) && rows > 0 ? Math.min(rows, 20) : 3;
    const count = gridColumnCount(settings) * rowCount;
    return Number.isFinite(count) && count > 0 ? Math.min(count, 100) : 15;
}
function buttonHasContent(button) {
    const actionType = String(button.action?.type || "none").trim();
    return ((actionType !== "" && actionType !== "none") ||
        singleLine(button.label || "") !== "");
}
function isIncomingCallIndicator(button) {
    return String(button.action?.type || "").trim() === "incoming_call_indicator";
}
function incomingCallIndicatorFeedbacks() {
    return [
        {
            feedbackId: "incoming_call_blink",
            options: {},
            style: {
                color: combineRgb(0, 0, 0),
                bgcolor: combineRgb(255, 210, 0),
            },
        },
    ];
}
function buttonPresetName(self, button) {
    if (!buttonHasContent(button)) {
        return `Key ${button.index + 1} - Empty`;
    }
    const resolvedLabel = cleanLabel(self.resolveSyncedButtonLabel(button), `Key ${button.index + 1}`);
    return `Key ${button.index + 1} - ${resolvedLabel}`;
}
function pageButtonsInGrid(settings, page) {
    const byIndex = new Map();
    for (const button of page.buttons || []) {
        if (!Number.isInteger(button.index) || button.index < 0)
            continue;
        byIndex.set(button.index, button);
    }
    return Array.from({ length: gridButtonCount(settings) }, (_, index) => (byIndex.get(index) || { index }));
}
function buildProfileButtonPreset(self, profile, page, button) {
    const hasContent = buttonHasContent(button);
    const isIndicator = isIncomingCallIndicator(button);
    const baseBg = parseButtonBgColor(button.color);
    const label = hasContent
        ? self.resolveSyncedButtonLabel(button) || `Key ${button.index + 1}`
        : "";
    const style = {
        text: label,
        size: "auto",
        color: deriveTextColor(baseBg),
        bgcolor: baseBg,
        show_topbar: false,
    };
    const actionOptions = {
        roleId: profile.roleId,
        buttonIndex: button.index,
        sourcePageNumber: page.page,
    };
    const shouldTriggerSlot = hasContent && !isIndicator;
    return {
        type: "button",
        category: profilePagePresetCategory(self, profile, page),
        name: buttonPresetName(self, button),
        style,
        previewStyle: style,
        feedbacks: isIndicator ? incomingCallIndicatorFeedbacks() : [],
        steps: shouldTriggerSlot
            ? [
                {
                    down: [
                        {
                            actionId: "trigger_synced_button",
                            options: { ...actionOptions, phase: "down" },
                        },
                    ],
                    up: [
                        {
                            actionId: "trigger_synced_button",
                            options: { ...actionOptions, phase: "up" },
                        },
                    ],
                },
            ]
            : [{ down: [], up: [] }],
        options: { stepAutoProgress: true },
    };
}
function sortedProfilePages(settings) {
    return (settings?.pages || [])
        .slice()
        .sort((a, b) => a.page - b.page);
}
function fallbackCurrentProfile(self) {
    if (!self.profileStreamDeckSettings)
        return [];
    return [
        {
            roleId: self.discovery.roleId || self.config.roleId || "role",
            roleName: self.discovery.roleName || "",
            username: self.discovery.username || self.config.username || "Default profile",
            profileVersion: self.profileVersion || 0,
            profileUpdatedAt: self.discovery.profileUpdatedAt || 0,
            streamDeckSettings: self.profileStreamDeckSettings,
        },
    ];
}
function sortedPresetProfiles(self) {
    const profiles = self.presetProfiles.length > 0
        ? self.presetProfiles
        : fallbackCurrentProfile(self);
    return profiles
        .slice()
        .sort((a, b) => {
        const roleCmp = cleanLabel(a.roleName || a.roleId, "role").localeCompare(cleanLabel(b.roleName || b.roleId, "role"), undefined, { sensitivity: "base" });
        if (roleCmp !== 0)
            return roleCmp;
        return cleanLabel(a.username, "profile").localeCompare(cleanLabel(b.username, "profile"), undefined, { sensitivity: "base" });
    });
}
export function BuildPresetSignature(self) {
    const compactProfiles = sortedPresetProfiles(self).map((profile) => ({
        roleId: profile.roleId,
        roleName: profile.roleName || "",
        username: profile.username,
        profileVersion: profile.profileVersion || 0,
        profileUpdatedAt: profile.profileUpdatedAt || 0,
        gridColumns: profile.streamDeckSettings.gridColumns,
        gridRows: profile.streamDeckSettings.gridRows,
        pages: sortedProfilePages(profile.streamDeckSettings).map((page) => ({
            page: page.page,
            title: page.title || "",
            buttons: pageButtonsInGrid(profile.streamDeckSettings, page).map((button) => ({
                index: button.index,
                label: button.label || "",
                color: button.color || "",
                action: button.action || null,
            })),
        })),
    }));
    return JSON.stringify({
        roleId: self.discovery.roleId || self.config.roleId || "",
        roleName: self.discovery.roleName || "",
        username: self.discovery.username || self.config.username || "",
        profileVersion: self.profileVersion || 0,
        profileUpdatedAt: self.discovery.profileUpdatedAt || 0,
        profiles: compactProfiles,
    });
}
export function UpdatePresets(self) {
    const presets = {};
    let count = 0;
    for (const profile of sortedPresetProfiles(self)) {
        for (const page of sortedProfilePages(profile.streamDeckSettings)) {
            for (const button of pageButtonsInGrid(profile.streamDeckSettings, page)) {
                const presetID = [
                    "profile",
                    presetIdPart(profile.roleId || "role"),
                    presetIdPart(profile.username || "profile"),
                    `p${page.page}`,
                    `k${button.index}`,
                ].join("_");
                presets[presetID] = buildProfileButtonPreset(self, profile, page, button);
                count += 1;
            }
        }
    }
    if (count === 0) {
        presets.profile_empty = {
            type: "text",
            category: rolePresetCategory(self),
            name: "No published buttons",
            text: "Publish a Kesher Stream Deck profile with configured buttons.",
        };
    }
    self.setPresetDefinitions(presets);
}
