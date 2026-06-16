export function GetConfigFields() {
    return [
        {
            type: "textinput",
            id: "host",
            label: "Backend host",
            default: "127.0.0.1",
            width: 8,
        },
        {
            type: "number",
            id: "port",
            label: "Backend port",
            default: 8080,
            min: 1,
            max: 65535,
            width: 4,
        },
        {
            type: "checkbox",
            id: "useTls",
            label: "Use TLS (wss)",
            default: false,
            width: 4,
        },
        {
            type: "textinput",
            id: "companionSecret",
            label: "Companion shared secret",
            default: "",
            width: 8,
        },
        {
            type: "textinput",
            id: "roleId",
            label: "Target role ID (preferred)",
            default: "",
            width: 8,
        },
        {
            type: "textinput",
            id: "username",
            label: "Target username (legacy fallback)",
            default: "",
            width: 8,
        },
    ];
}
