# Visma Flyt Skole for Clearsky

A [Clearsky](https://github.com/ethlo/clearsky) plugin. If your children's school uses Visma Flyt Skole (Min Skole / Flyt Foresatt), it shows what waits for you there: unread messages and notices, and forms and consents to answer. Form deadlines show up in Now / Next. It only reads. It never replies or marks anything as read, so the portal still shows everything as unread.

## Add it

```sh
clearsky add visma-flyt --trust
```

or **Settings → Plugins → School → Add**. `visma-flyt` is the name in Clearsky's catalog, pinned to a released version; `clearsky add github:ethlo/clearsky-visma-flyt#v1.0.0 --trust` is the same thing spelled out. It needs `--trust` (or the box in Settings) because it runs inside Clearsky rather than in a sandbox of its own: the login opens a browser window and the session is kept in your keyring.

Then, in Settings under **Plugins → Visma Flyt Skole**:

1. Set **School portal key**: the last part of `https://foresatt.visma.no/<key>`.
2. Click **Log in with BankID**. A Chrome or Chromium window opens. Log in with BankID or MinID, and the window closes by itself once you're in. Set `CLEARSKY_BROWSER` if your browser isn't found.

## Weekly plans in the calendar

The weekly plans the school sends as PDF or Word files become events on a calendar of their own, **School**, inside Clearsky: trips and theme days at the times the plan gives, when school ends each day, homework on the day it's due, and SFO activities. What's the same every day (frilek, lunsj, storefri) is left out. It's read by script, no AI: a plan laid out as a table with the weekdays as columns works; a plan written as prose gives nothing. Each file is read once and what came out of it is kept in `~/.config/clearsky/school-events.json` (mode 600). The events show in the day schedule without taking your time, and each opens the message it came from. Turn it off, or rename the calendar, in Settings (**Weekly plans in the calendar**, **Calendar for weekly plans**). PDFs need `pdftotext` (poppler-utils).

## The login

The login is kept in the GNOME keyring (`secret-tool`), or in `~/.config/clearsky/flyt-session.json` (mode 600) if there's no keyring. Clearsky renews the login itself. When Visma ends the login, the School panel links you to Settings to log in again. Running Clearsky in Docker: log in natively, then `clearsky school-handover` moves the login into the container's keyring.

There is no public API. This uses the one the portal itself uses, as documented by [skolectl](https://github.com/langtind/skolectl), so it can break when Visma changes the portal.

## Develop

```sh
git clone --depth 1 https://github.com/ethlo/clearsky .clearsky
CLEARSKY_CORE=.clearsky npm test
```

Some tests load the plugin the way Clearsky does, so they need a Clearsky checkout (see `test/core.mjs`). The weekly plans in `test/fixtures` are real plans with the school's name, phone and people's names taken out. Release by bumping `version` in `clearsky-plugin.json` and `package.json` and tagging `v<version>`; Clearsky's catalog pins that tag.
