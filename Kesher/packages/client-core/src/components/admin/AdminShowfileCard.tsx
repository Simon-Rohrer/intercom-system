import { ChangeEvent, useMemo, useState } from "react";
import {
	exportConfiguration,
	importConfiguration,
} from "../../api";
import type {
	ConfigurationDocument,
	ConfigurationSection,
} from "../../types";

type AdminShowfileCardProps = {
	token: string;
	adminPin: string;
	refreshBootstrapData: () => Promise<void>;
};

const availableSections: Array<{
	key: ConfigurationSection;
	label: string;
	description: string;
}> = [
	{
		key: "roles",
		label: "Roles",
		description: "Role names and default operator settings.",
	},
	{
		key: "users",
		label: "User Roles",
		description: "Username-to-role assignments.",
	},
	{
		key: "rooms",
		label: "Party Lines",
		description: "Party-line names and talk/listen permissions.",
	},
	{
		key: "broadcastGroups",
		label: "Broadcast Channels",
		description: "Broadcast channel membership and allowed roles.",
	},
	{
		key: "telegramAllowlist",
		label: "Telegram Whitelist",
		description: "Telegram usernames and mapped Kesher users.",
	},
	{
		key: "telegramMappings",
		label: "Telegram Room Mappings",
		description: "Telegram chats mapped to Kesher party lines.",
	},
	{
		key: "telegramUsers",
		label: "Telegram Users & Subscriptions",
		description: "Linked Telegram identities, private chats and party-line subscriptions.",
	},
	{
		key: "ackSettings",
		label: "ACK Settings",
		description: "Global ACK cue toggle.",
	},
	{
		key: "streamDeckSettings",
		label: "Stream Deck Profiles",
		description: "Per-role Stream Deck button and page mappings.",
	},
	{
		key: "companionProfiles",
		label: "Companion Profiles",
		description: "Published Companion profiles and their versions.",
	},
	{
		key: "companionRolePages",
		label: "Companion Role Pages",
		description: "Configured Companion start page for every role.",
	},
];

function createSectionSelection(): Record<ConfigurationSection, boolean> {
	return {
		roles: true,
		users: true,
		rooms: true,
		broadcastGroups: true,
		telegramAllowlist: true,
		telegramMappings: true,
		telegramUsers: true,
		ackSettings: true,
		streamDeckSettings: true,
		companionProfiles: true,
		companionRolePages: true,
	};
}

export function AdminShowfileCard({
	token,
	adminPin,
	refreshBootstrapData,
}: AdminShowfileCardProps) {
	const [isOpen, setIsOpen] = useState(false);
	const [busy, setBusy] = useState(false);
	const [importText, setImportText] = useState("");
	const [message, setMessage] = useState("");
	const [error, setError] = useState("");
	const [backupBeforeImport, setBackupBeforeImport] = useState(true);
	const [exportSectionSelection, setExportSectionSelection] = useState(
		createSectionSelection,
	);
	const [importSectionSelection, setImportSectionSelection] = useState(
		createSectionSelection,
	);

	function downloadShowfile(document: ConfigurationDocument, filenamePrefix: string) {
		const payload = JSON.stringify(document, null, 2);
		const blob = new Blob([payload], { type: "application/json" });
		const url = window.URL.createObjectURL(blob);
		const anchor = window.document.createElement("a");
		const timestamp = document.meta.exportedAt
			.replace(/[:]/g, "-")
			.replace(/[.]/g, "_");
		anchor.href = url;
		anchor.download = `${filenamePrefix}-${timestamp}.json`;
		window.document.body.appendChild(anchor);
		anchor.click();
		anchor.remove();
		window.URL.revokeObjectURL(url);
	}

	const selectedExportSections = useMemo(
		() =>
			availableSections
				.filter((section) => exportSectionSelection[section.key])
				.map((section) => section.key),
		[exportSectionSelection],
	);

	const selectedImportSections = useMemo(
		() =>
			availableSections
				.filter((section) => importSectionSelection[section.key])
				.map((section) => section.key),
		[importSectionSelection],
	);

	function updateExportSectionSelection(section: ConfigurationSection) {
		setExportSectionSelection((current) => ({
			...current,
			[section]: !current[section],
		}));
	}

	function updateImportSectionSelection(section: ConfigurationSection) {
		setImportSectionSelection((current) => ({
			...current,
			[section]: !current[section],
		}));
	}

	function selectAllSections(
		setter: typeof setExportSectionSelection,
		selected: boolean,
	) {
		setter(
			Object.fromEntries(
				availableSections.map((section) => [section.key, selected]),
			) as Record<ConfigurationSection, boolean>,
		);
	}

	function handleImportFile(event: ChangeEvent<HTMLInputElement>) {
		const file = event.target.files?.[0];
		if (!file) return;
		void file.text().then((text) => {
			setImportText(text);
			try {
				const parsed = JSON.parse(text) as ConfigurationDocument;
				const includedSections = new Set(parsed.meta?.sections || []);
				setImportSectionSelection(
					Object.fromEntries(
						availableSections.map((section) => [
							section.key,
							includedSections.has(section.key),
						]),
					) as Record<ConfigurationSection, boolean>,
				);
			} catch {
				// The import action reports malformed JSON with the existing error UI.
			}
			setMessage(`Loaded ${file.name}.`);
			setError("");
		});
		event.target.value = "";
	}

	async function handleExport() {
		setBusy(true);
		setMessage("");
		setError("");
		try {
			const document = await exportConfiguration(
				token,
				adminPin,
				selectedExportSections,
			);
			downloadShowfile(document, "kesher-showfile");
			setMessage("Configuration exported as showfile JSON.");
		} catch (err) {
			setError(err instanceof Error ? err.message : "export failed");
		} finally {
			setBusy(false);
		}
	}

	async function handleImport() {
		if (!importText.trim() || selectedImportSections.length === 0) {
			return;
		}
		setBusy(true);
		setMessage("");
		setError("");
		try {
			if (backupBeforeImport) {
				const backupDocument = await exportConfiguration(token, adminPin);
				downloadShowfile(backupDocument, "kesher-showfile-backup-before-import");
			}
			const parsed = JSON.parse(importText) as ConfigurationDocument;
			const documentSections = new Set(parsed.meta?.sections || []);
			const effectiveImportSections = selectedImportSections.filter((section) =>
				documentSections.has(section),
			);
			if (effectiveImportSections.length === 0) {
				throw new Error("The showfile does not contain any selected sections.");
			}
			const response = await importConfiguration(
				token,
				adminPin,
				parsed,
				effectiveImportSections,
			);
			await refreshBootstrapData();
			setMessage(
				`Imported sections: ${response.importedSections.join(", ")}.`,
			);
		} catch (err) {
			setError(err instanceof Error ? err.message : "import failed");
		} finally {
			setBusy(false);
		}
	}

	return (
		<div className="admin-card">
			<div className="admin-card-header">
				<div className="admin-card-title">Configuration · Showfile</div>
				<div className="admin-card-actions">
					<button
						className="admin-toggle-button"
						onClick={() => setIsOpen((value) => !value)}
						aria-expanded={isOpen}
					>
						{isOpen ? "Hide" : "Show"}
					</button>
				</div>
			</div>
			{isOpen ? (
				<div className="admin-card-body">
					<div className="admin-block">
						<div className="admin-block-header">
							<h4>Export</h4>
						</div>
						<p>
							Choose the configuration areas to include. Everything is selected
							by default for a complete system copy.
						</p>
						<p className="admin-block-subtitle">
							Runtime history and credentials such as the Admin PIN, Telegram bot
							token and Companion secret are intentionally not written to showfiles.
						</p>
						<div className="admin-form-actions">
							<span className="admin-block-subtitle">
								{selectedExportSections.length} of {availableSections.length} selected
							</span>
							<button
								type="button"
								className="secondary"
								onClick={() => selectAllSections(setExportSectionSelection, true)}
								disabled={busy}
							>
								Select all
							</button>
							<button
								type="button"
								className="secondary"
								onClick={() => selectAllSections(setExportSectionSelection, false)}
								disabled={busy}
							>
								Clear selection
							</button>
						</div>
						<div className="admin-grid admin-showfile-sections">
							{availableSections.map((section) => (
								<label
									key={`export-${section.key}`}
									className="admin-checkbox admin-checkbox-wide"
								>
									<input
										type="checkbox"
										checked={exportSectionSelection[section.key]}
										onChange={() => updateExportSectionSelection(section.key)}
										disabled={busy}
									/>
									<span>
										<strong>{section.label}</strong>
										<br />
										<small>{section.description}</small>
									</span>
								</label>
							))}
						</div>
						<div className="admin-form-actions">
							<button
								onClick={() => void handleExport()}
								disabled={busy || selectedExportSections.length === 0}
							>
								{busy ? "Working..." : "Export showfile"}
							</button>
						</div>
					</div>

					<div className="admin-block">
						<div className="admin-block-header">
							<h4>Import</h4>
						</div>
						<p>
							Paste a showfile JSON document or load it from disk. Only the
							selected sections will be applied.
						</p>
						<div className="admin-grid">
							<label className="admin-checkbox admin-checkbox-wide">
								<span>Load JSON file</span>
								<input
									type="file"
									accept="application/json,.json"
									onChange={handleImportFile}
									disabled={busy}
								/>
							</label>
						</div>
						<div className="admin-grid">
							<textarea
								value={importText}
								onChange={(event) => setImportText(event.target.value)}
								placeholder="Paste showfile JSON here"
								rows={14}
							/>
						</div>
						<div className="admin-grid">
							<label className="admin-checkbox admin-checkbox-wide">
								<input
									type="checkbox"
									checked={backupBeforeImport}
									onChange={() => setBackupBeforeImport((value) => !value)}
									disabled={busy}
								/>
								<span>
									<strong>Create Backup Before Import</strong>
									<br />
									<small>
										Downloads current live configuration before applying the
										import.
									</small>
								</span>
							</label>
						</div>
						<div className="admin-grid">
							{availableSections.map((section) => (
								<label
									key={section.key}
									className="admin-checkbox admin-checkbox-wide"
								>
									<input
										type="checkbox"
									checked={importSectionSelection[section.key]}
									onChange={() => updateImportSectionSelection(section.key)}
										disabled={busy}
									/>
									<span>
										<strong>{section.label}</strong>
										<br />
										<small>{section.description}</small>
									</span>
								</label>
							))}
						</div>
						<div className="admin-form-actions">
							<button
								onClick={() => void handleImport()}
								disabled={busy || !importText.trim() || selectedImportSections.length === 0}
							>
								{busy ? "Working..." : "Import selected sections"}
							</button>
						</div>
					</div>

					{error ? <p className="admin-error">{error}</p> : null}
					{message ? <p>{message}</p> : null}
				</div>
			) : null}
		</div>
	);
}
