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
function buttonHasContent(button) {
    const actionType = String(button.action?.type || "none").trim();
    return ((actionType !== "" && actionType !== "none") ||
        singleLine(button.label || "") !== "");
}
function buttonPresetName(self, page, button) {
    const resolvedLabel = cleanLabel(self.resolveSyncedButtonLabel(button), `Key ${button.index + 1}`);
    return `${pageLabel(page)} / Key ${button.index + 1} - ${resolvedLabel}`;
}
function buildProfileButtonPreset(self, profile, page, button) {
    const baseBg = parseButtonBgColor(button.color);
    const label = self.resolveSyncedButtonLabel(button) || `Key ${button.index + 1}`;
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
    return {
        type: "button",
        category: rolePresetCategory(self, profile),
        name: buttonPresetName(self, page, button),
        style,
        previewStyle: style,
        feedbacks: [],
        steps: [
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
        ],
        options: { stepAutoProgress: true },
    };
}
function sortedProfilePages(settings) {
    return (settings?.pages || [])
        .slice()
        .sort((a, b) => a.page - b.page);
}
function configuredButtons(page) {
    return (page.buttons || [])
        .filter(buttonHasContent)
        .slice()
        .sort((a, b) => a.index - b.index);
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
        pages: sortedProfilePages(profile.streamDeckSettings).map((page) => ({
            page: page.page,
            title: page.title || "",
            buttons: configuredButtons(page).map((button) => ({
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
            for (const button of configuredButtons(page)) {
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
