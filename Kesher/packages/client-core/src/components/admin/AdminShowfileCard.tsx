import { ChangeEvent, useMemo, useState } from "react";
import {
	exportConfiguration,
	importConfiguration,
} from "../../api";
import type {
	ConfigurationDocument,
	ConfigurationSection,
} from "../../types";
import { AdminCardHeader } from "./AdminCardHeader";
import { useAdminCardOpenState } from "./adminCardOpen";

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
		label: "Rollen",
		description: "Rollennamen und Standardeinstellungen für Bediener.",
	},
	{
		key: "users",
		label: "Benutzerrollen",
		description: "Zuordnung von Benutzernamen zu Rollen.",
	},
	{
		key: "rooms",
		label: "Party Lines",
		description: "Namen der Party Lines sowie Sprech- und Hörrechte.",
	},
	{
		key: "broadcastGroups",
		label: "Durchsage-Kanäle",
		description: "Mitglieder der Durchsage-Kanäle und erlaubte Rollen.",
	},
	{
		key: "telegramAllowlist",
		label: "Telegram-Freigabeliste",
		description: "Telegram-Benutzernamen und zugeordnete Kesher-Benutzer.",
	},
	{
		key: "telegramMappings",
		label: "Telegram-Chat-Zuordnungen",
		description: "Telegram-Chats, die Kesher-Party-Lines zugeordnet sind.",
	},
	{
		key: "telegramUsers",
		label: "Telegram-Benutzer & Abos",
		description: "Verknüpfte Telegram-Konten, private Chats und Party-Line-Abos.",
	},
	{
		key: "ackSettings",
		label: "Bestätigungs-Einstellungen",
		description: "Globaler Schalter für Bestätigungs-Hinweise (ACK).",
	},
	{
		key: "streamDeckSettings",
		label: "Stream-Deck-Profile",
		description: "Stream-Deck-Tasten und Seiten pro Rolle.",
	},
	{
		key: "companionProfiles",
		label: "Companion-Profile",
		description: "Veröffentlichte Companion-Profile und ihre Versionen.",
	},
	{
		key: "companionRolePages",
		label: "Companion-Seiten pro Rolle",
		description: "Eingestellte Companion-Startseite für jede Rolle.",
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
	const [isOpen, setIsOpen] = useAdminCardOpenState();
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
			setMessage(`${file.name} geladen.`);
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
			setMessage("Konfiguration als Showfile (JSON) exportiert.");
		} catch (err) {
			setError(err instanceof Error ? err.message : "Export fehlgeschlagen");
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
				throw new Error("Das Showfile enthält keinen der ausgewählten Bereiche.");
			}
			const response = await importConfiguration(
				token,
				adminPin,
				parsed,
				effectiveImportSections,
			);
			await refreshBootstrapData();
			const warningText = response.warnings?.length
				? ` Warnungen: ${response.warnings.join(" ")}`
				: "";
			setMessage(
				`Importierte Bereiche: ${response.importedSections
						.map(
							(key) =>
								availableSections.find((section) => section.key === key)?.label ||
								key,
						)
						.join(", ")}.${warningText}`,
			);
		} catch (err) {
			setError(err instanceof Error ? err.message : "Import fehlgeschlagen");
		} finally {
			setBusy(false);
		}
	}

	return (
		<div className="admin-card">
			<AdminCardHeader
				title="Showfile"
				isOpen={isOpen}
				onToggle={() => setIsOpen((value) => !value)}
			/>
			{isOpen ? (
				<div className="admin-card-body">
					<div className="admin-block">
						<div className="admin-block-header">
							<h4>Exportieren</h4>
						</div>
						<p>
							Wähle die Bereiche aus, die gespeichert werden sollen. Für eine
							vollständige Kopie des Systems ist standardmäßig alles ausgewählt.
						</p>
						<p className="admin-block-subtitle">
							Verläufe und Zugangsdaten wie Admin-PIN, Telegram-Bot-Token und
							Companion-Geheimnis werden bewusst nicht ins Showfile geschrieben.
						</p>
						<div className="admin-form-actions">
							<span className="admin-block-subtitle">
								{selectedExportSections.length} von {availableSections.length} ausgewählt
							</span>
							<button
								type="button"
								className="secondary"
								onClick={() => selectAllSections(setExportSectionSelection, true)}
								disabled={busy}
							>
								Alle auswählen
							</button>
							<button
								type="button"
								className="secondary"
								onClick={() => selectAllSections(setExportSectionSelection, false)}
								disabled={busy}
							>
								Auswahl aufheben
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
								{busy ? "Bitte warten …" : "Showfile exportieren"}
							</button>
						</div>
					</div>

					<div className="admin-block">
						<div className="admin-block-header">
							<h4>Importieren</h4>
						</div>
						<p>
							Showfile (JSON) hier einfügen oder als Datei laden. Nur die
							ausgewählten Bereiche werden übernommen.
						</p>
						<div className="admin-grid">
							<label className="admin-checkbox admin-checkbox-wide">
								<span>JSON-Datei laden</span>
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
								placeholder="Showfile-JSON hier einfügen"
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
									<strong>Vor dem Import Sicherung erstellen</strong>
									<br />
									<small>
										Lädt die aktuelle Konfiguration herunter, bevor der Import
										übernommen wird.
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
								{busy ? "Bitte warten …" : "Ausgewählte Bereiche importieren"}
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
