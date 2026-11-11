#!/usr/bin/env python3
"""Abgehakte ToDos auf der Notion-Seite „JMS Server“ ins Archiv verschieben.

Für die Listen „ToDos Lasse:“, „ToDos Simon:“ und „Vor Ort testen:“ (Toggles auf der Seite) gibt es je
einen aufklappbaren Bereich „✓ Erledigt – <Liste>“ direkt darunter. Abgehakte Punkte werden samt
Unterpunkten/Notizen dorthin kopiert und am alten Platz gelöscht (die Notion-Schnittstelle kann Blöcke
nicht verschieben). Die Liste „Technik-Mängel“ bleibt unangetastet – die gleicht JMS Control selbst ab.

Zugang: dieselbe Notion-Verbindung wie der Technik-Mängel-Abgleich (Schlüssel in ops-notion.json im
Datenordner von JMS Control). Nur Lesen, Einfügen und Löschen von Blöcken auf dieser Seite.

Aufruf: notion-archiv.py [--dry-run] [--config /pfad/ops-notion.json]
"""
import argparse
import json
import sys
import time
import urllib.error
import urllib.request

PAGE_ID = "3f2e7078-4cde-811a-8868-de9dbfb3d318"
LISTS = ("ToDos Lasse", "ToDos Simon", "Vor Ort testen")
ARCHIVE_PREFIX = "✓ Erledigt – "
DEFAULT_CONFIG = "/var/lib/docker/volumes/multiview_multiview-data/_data/ops-notion.json"
# Blockarten, die sich 1:1 neu anlegen lassen (alles andere bleibt sicherheitshalber stehen)
COPYABLE = {
    "paragraph", "to_do", "bulleted_list_item", "numbered_list_item", "toggle", "quote", "callout",
    "heading_1", "heading_2", "heading_3", "code", "divider", "bookmark", "equation",
}
WRITABLE_KEYS = {"rich_text", "checked", "color", "language", "caption", "url", "expression", "icon", "is_toggleable"}


class Notion:
    def __init__(self, token, dry_run=False):
        self.token = token
        self.dry_run = dry_run
        self.last = 0.0

    def request(self, method, path, body=None):
        # Notion erlaubt etwa 3 Anfragen pro Sekunde
        wait = 0.35 - (time.monotonic() - self.last)
        if wait > 0:
            time.sleep(wait)
        self.last = time.monotonic()
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(
            "https://api.notion.com/v1" + path, data=data, method=method,
            headers={"Authorization": "Bearer " + self.token, "Notion-Version": "2025-09-03", "Content-Type": "application/json"},
        )
        for attempt in range(4):
            try:
                with urllib.request.urlopen(req, timeout=20) as response:
                    return json.load(response)
            except urllib.error.HTTPError as error:
                if error.code == 429 and attempt < 3:
                    time.sleep(float(error.headers.get("Retry-After") or 2))
                    continue
                # Grund von Notion mitgeben (steht sonst nirgends)
                error.msg = f"{error.msg}: {error.read()[:400].decode('utf-8', 'replace')}"
                raise

    def children(self, block_id):
        out, cursor = [], None
        while True:
            query = "?page_size=100" + (f"&start_cursor={cursor}" if cursor else "")
            data = self.request("GET", f"/blocks/{block_id}/children{query}")
            out += data["results"]
            if not data.get("has_more"):
                return out
            cursor = data["next_cursor"]

    def append(self, parent_id, blocks, after=None):
        if self.dry_run:
            return {"results": [{"id": "probelauf"}]}
        body = {"children": blocks}
        if after:
            body["position"] = {"type": "after_block", "after_block": {"id": after}}
        try:
            return self.request("PATCH", f"/blocks/{parent_id}/children", body)
        except urllib.error.HTTPError as error:
            if not after or error.code != 400:
                raise
            # Ältere Schnittstelle: Einfügeposition heißt „after“
            body.pop("position", None)
            body["after"] = after
            return self.request("PATCH", f"/blocks/{parent_id}/children", body)

    def delete(self, block_id):
        if not self.dry_run:
            self.request("DELETE", f"/blocks/{block_id}")


def plain(block):
    return "".join(part.get("plain_text", "") for part in block.get(block["type"], {}).get("rich_text", []))


def clean_rich_text(parts):
    out = []
    for part in parts or []:
        kind = part.get("type")
        if kind == "text":
            out.append({"type": "text", "text": {"content": part["text"]["content"], "link": part["text"].get("link")}, "annotations": part.get("annotations", {})})
        elif kind == "equation":
            out.append({"type": "equation", "equation": part["equation"], "annotations": part.get("annotations", {})})
        else:  # Erwähnungen (Personen, Seiten, Daten) als Text übernehmen
            out.append({"type": "text", "text": {"content": part.get("plain_text", "")}, "annotations": part.get("annotations", {})})
    return out


def copy_block(notion, block):
    """Block samt Unterblöcken als neu anlegbares JSON – None, wenn etwas nicht kopierbar ist."""
    kind = block["type"]
    if kind not in COPYABLE:
        return None
    # Leere Felder (z. B. icon: null) lehnt Notion beim Anlegen ab – weglassen
    content = {k: v for k, v in block.get(kind, {}).items() if k in WRITABLE_KEYS and v is not None}
    for key in ("rich_text", "caption"):
        if key in content:
            content[key] = clean_rich_text(content[key])
    result = {"object": "block", "type": kind, kind: content}
    if block.get("has_children"):
        kids = []
        for child in notion.children(block["id"]):
            copied = copy_block(notion, child)
            if copied is None:
                return None
            kids.append(copied)
        if kids:
            content["children"] = kids
    return result


def run(notion, log):
    page = notion.children(PAGE_ID)
    by_title = {}
    for block in page:
        if block["type"] == "toggle":
            by_title.setdefault(plain(block).strip().rstrip(":").strip(), block)
    moved = 0
    for name in LISTS:
        source = by_title.get(name)
        if not source:
            continue
        done = [b for b in notion.children(source["id"]) if b["type"] == "to_do" and b["to_do"].get("checked")]
        if not done:
            continue
        archive = by_title.get(ARCHIVE_PREFIX + name)
        if not archive:
            created = notion.append(PAGE_ID, [{"object": "block", "type": "toggle", "toggle": {
                "rich_text": [{"type": "text", "text": {"content": ARCHIVE_PREFIX + name}}], "color": "gray"}}], after=source["id"])
            archive = created["results"][0]
            by_title[ARCHIVE_PREFIX + name] = archive
            log(f"Archiv „{ARCHIVE_PREFIX + name}“ angelegt")
        for item in done:
            copied = copy_block(notion, item)
            if copied is None:
                log(f"Übersprungen (enthält Inhalte, die sich nicht kopieren lassen): {plain(item)[:80]}")
                continue
            notion.append(archive["id"], [copied])
            notion.delete(item["id"])
            moved += 1
            log(f"Archiviert ({name}): {plain(item)[:80]}")
    return moved


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--dry-run", action="store_true", help="nur anzeigen, nichts ändern")
    parser.add_argument("--config", default=DEFAULT_CONFIG)
    args = parser.parse_args()
    with open(args.config, encoding="utf-8") as handle:
        config = json.load(handle)
    if not config.get("token"):
        print("Kein Notion-Schlüssel eingerichtet – nichts zu tun")
        return 0
    notion = Notion(config["token"], dry_run=args.dry_run)
    prefix = "Probelauf: " if args.dry_run else ""
    moved = run(notion, lambda message: print(prefix + message, flush=True))
    if moved:
        print(f"{prefix}{moved} erledigte(r) Punkt(e) archiviert")
    return 0


if __name__ == "__main__":
    sys.exit(main())
