#!/usr/bin/env python3
"""
Migrate all Firefox-based webapps on this machine to a Chromium backend.

Firefox dropped the licensing for proprietary codecs (H.264/AAC), so every
webapp that previously ran on Firefox / GNU IceCat is re-homed onto
google-chrome-stable (the real Chromium backend on this box — the `chromium`
wrapper pointed at a dangling /usr/bin/vivaldi symlink).

What this migrates:
  1. 331 PWAs managed by the "PWAsForFirefox" extension
     (store: ~/.local/share/firefoxpwa/config.json, launchers: FFPWA-*.desktop)
  2. 3 GNU IceCat "WebApp-*.desktop" webapps
  3. (Separately handled: the gvoice/discord/whatsapp/bluesky wrappers,
     the `chromium` wrapper, and the text/html xdg handler)

Per-app isolation is preserved via a dedicated chrome --user-data-dir per app
under ~/.config/eilatan-webapps/<slug>, exactly like each PWA previously had
its own Firefox profile.

Originals are backed up to ./migration-backup/ inside this repo.
"""
import json
import os
import re
import shutil
import sys
from datetime import datetime
from urllib.parse import urlparse

HOME = os.path.expanduser("~")
BACKEND = "google-chrome-stable"
APPS_ROOT = os.path.join(HOME, ".config", "eilatan-webapps")
STORE = os.path.join(HOME, ".local", "share", "firefoxpwa", "config.json")
APPS_DIR = os.path.join(HOME, ".local", "share", "applications")

HERE = os.path.dirname(os.path.abspath(__file__))
BACKUP_DIR = os.path.join(HERE, "migration-backup")
BACKUP_DESKTOP = os.path.join(BACKUP_DIR, "desktop")
BACKUP_BIN = os.path.join(BACKUP_DIR, "bin")

DESKTOP_HEADER = """[Desktop Entry]
Type=Application
Version=1.4
"""


def slugify(name: str, maxlen: int = 48) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")
    return s[:maxlen].rstrip("-") or "app"


def first_http(*candidates) -> str | None:
    for c in candidates:
        if not c or not isinstance(c, str):
            continue
        c = c.strip()
        if c.startswith("http://") or c.startswith("https://"):
            return c
    return None


def host_of(url: str) -> str:
    try:
        return urlparse(url).netloc
    except Exception:
        return "unknown"


def desktop_for_app(uid: str, name: str, url: str, icon: str,
                    categories: str, comment: str, migrated_from: str,
                    profile_name: str) -> str:
    slug = slugify(profile_name)
    data_dir = os.path.join(APPS_ROOT, f"{slug}-{uid[-8:]}")
    exec_line = (f'Exec={BACKEND} --app="{url}" '
                 f'--user-data-dir="{data_dir}" '
                 f"--no-first-run --no-default-browser-check")
    lines = [
        DESKTOP_HEADER.rstrip("\n"),
        f"Name={name}",
        f"Comment={comment}",
        "Keywords=;",
        f"Categories={categories or 'Network;WebBrowser;'}",
        f"Icon={icon}",
        exec_line,
        "Terminal=false",
        "StartupNotify=true",
        "StartupWMClass=Google-chrome",
        f"X-WebApp-URL={url}",
        "X-WebApp-Browser=Chromium (Google Chrome)",
        f"X-Migrated-From={migrated_from}",
        "",
    ]
    return "\n".join(lines), data_dir


def parse_old_desktop(path: str) -> dict:
    """Pull Name/Categories out of an existing launcher."""
    out = {"name": None, "categories": None}
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            for line in f:
                line = line.rstrip("\n")
                if line.startswith("Name=") and out["name"] is None:
                    out["name"] = line.split("=", 1)[1]
                elif line.startswith("Categories=") and out["categories"] is None:
                    out["categories"] = line.split("=", 1)[1]
    except OSError:
        pass
    return out


def migrate_ffpwa(store: str) -> list:
    cfg = json.load(open(store, encoding="utf-8"))
    sites = cfg.get("sites", {})
    manifest_out = []
    skipped = []
    for uid, site in sites.items():
        manifest = site.get("manifest") or {}
        conf = site.get("config") or {}
        url = first_http(manifest.get("start_url"),
                         conf.get("document_url"),
                         manifest.get("scope"))
        if not url:
            skipped.append(uid)
            continue

        name = (manifest.get("name") or manifest.get("short_name")
                or host_of(url).split(":")[0])
        name = re.sub(r"\s+", " ", str(name)).strip() or host_of(url)
        comment = manifest.get("description") or url

        old = os.path.join(APPS_DIR, f"FFPWA-{uid}.desktop")
        old_meta = parse_old_desktop(old) if os.path.exists(old) else {}
        icon = f"FFPWA-{uid}"
        categories = old_meta.get("categories") or "Network;WebBrowser;"

        content, data_dir = desktop_for_app(
            uid, name, url, icon, categories, comment,
            migrated_from=f"FFPWA-{uid}",
            profile_name=f"{slugify(name)}-{uid[:4]}",
        )
        new_file = os.path.join(APPS_DIR, f"chrome-{slugify(name)}-{uid[-8:]}.desktop")
        with open(new_file, "w", encoding="utf-8") as f:
            f.write(content)
        manifest_out.append({
            "old_id": f"FFPWA-{uid}",
            "name": name,
            "url": url,
            "launcher": os.path.basename(new_file),
            "data_dir": data_dir,
        })
    return manifest_out, skipped


def migrate_icecat_webapps(webapps: list) -> list:
    out = []
    for slug, name, url, icon in webapps:
        uid = "WEBAPP"
        content, data_dir = desktop_for_app(
            uid, name, url, icon, "Network;WebBrowser;", url,
            migrated_from=f"icecat-webapp-{slug}", profile_name=slug,
        )
        new_file = os.path.join(APPS_DIR, f"chrome-{slug}.desktop")
        with open(new_file, "w", encoding="utf-8") as f:
            f.write(content)
        out.append({
            "old_id": f"WebApp-{slug}",
            "name": name,
            "url": url,
            "launcher": os.path.basename(new_file),
            "data_dir": data_dir,
        })
    return out


def backup() -> None:
    os.makedirs(BACKUP_DESKTOP, exist_ok=True)
    os.makedirs(BACKUP_BIN, exist_ok=True)
    for f in os.listdir(APPS_DIR):
        if f.startswith("FFPWA-") and f.endswith(".desktop"):
            shutil.copy2(os.path.join(APPS_DIR, f), os.path.join(BACKUP_DESKTOP, f))
        if f.startswith("WebApp-") and f.endswith(".desktop"):
            shutil.copy2(os.path.join(APPS_DIR, f), os.path.join(BACKUP_DESKTOP, f))
    for f in ["gvoice", "discord", "discord-sidebar", "whatsapp", "bluesky"]:
        p = os.path.join(HOME, ".local", "bin", f)
        if os.path.exists(p):
            shutil.copy2(p, os.path.join(BACKUP_BIN, f))
    if os.path.exists(STORE):
        shutil.copy2(STORE, os.path.join(BACKUP_DIR, "firefoxpwa-config.json"))
    shutil.copy2(os.path.join(HERE, "migrate_to_chromium.py"),
                 os.path.join(BACKUP_DIR, "migrate_to_chromium.py"))
    print(f"[backup] saved originals to {BACKUP_DIR}")


def remove_old_launchers() -> None:
    removed = 0
    for f in os.listdir(APPS_DIR):
        if f.startswith("FFPWA-") and f.endswith(".desktop"):
            os.remove(os.path.join(APPS_DIR, f))
            removed += 1
        if f.startswith("WebApp-") and f.endswith(".desktop"):
            os.remove(os.path.join(APPS_DIR, f))
            removed += 1
    print(f"[cleanup] removed {removed} old Firefox/IceCat launchers")


def main() -> None:
    backup()

    pwas, skipped = migrate_ffpwa(STORE)

    icecat = migrate_icecat_webapps([
        # (slug, name, url, icon) — "Firefox Extensions" becomes the Chrome
        # Web Store since addons.mozilla.org is meaningless on Chromium.
        ("extensions", "Extensions", "https://chromewebstore.google.com",
         "/home/natalie/.local/share/ice/icons/FirefoxExtensions.png"),
        ("search", "Search", "https://html.duckduckgo.com/html/",
         "/home/natalie/.local/share/ice/icons/Search.png"),
        ("x", "X", "https://x.com",
         "/home/natalie/.local/share/ice/icons/X.png"),
    ])

    report = {
        "migrated_at": datetime.now().isoformat(timespec="seconds"),
        "backend": BACKEND,
        "data_root": APPS_ROOT,
        "pwa_count": len(pwas),
        "icecat_count": len(icecat),
        "skipped_pwa_ids": skipped,
        "apps": pwas + icecat,
    }
    with open(os.path.join(HERE, "migrated-apps.json"), "w", encoding="utf-8") as f:
        json.dump(report, f, indent=2)

    print(f"[migrate] {len(pwas)} FFPWA PWAs -> chromium .desktop launchers")
    print(f"[migrate] {len(icecat)} IceCat webapps -> chromium .desktop launchers")
    if skipped:
        print(f"[migrate] WARNING: skipped {len(skipped)} sites (no usable URL): "
              f"{skipped}")
    print(f"[migrate] manifest written to {os.path.join(HERE, 'migrated-apps.json')}")

    remove_old_launchers()


if __name__ == "__main__":
    sys.exit(main())
