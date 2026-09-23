# JungscharChat

Ein privater, webbasierter Gruppen-Chat für unsere Jungschar mit Login-System und Echtzeit-Kommunikation.

🌐 **Live-Anwendung:** [myjungschar.github.io/chat](https://myjungschar.github.io/chat/)

---

## 🚀 Features

* 🔐 **Benutzer-Authentifizierung:** Sicherer Login für Gruppenmitglieder via Supabase Auth.
* ⚡ **Echtzeit-Chat:** Nachrichten werden ohne Neuladen der Seite sofort empfangen (Supabase Realtime).
* 🛡️ **Sicherheit & Datenbank:** Integrierter XSS-Schutz für Nachrichten und automatischer Ringpuffer in PostgreSQL (max. 300 Nachrichten).
* 🛠️ **Moderation:** Geplante Admin-Funktionen zum Löschen von Nachrichten und Verwalten von Benutzern.

---

## 🛠️ Tech Stack

* **Frontend:** HTML5, CSS3, Vanilla JavaScript (Single-Page-Application)
* **Backend / Datenbank:** Supabase (PostgreSQL, Auth, Realtime)
* **Hosting:** GitHub Pages

---

*Erstellt für die Jungschar-Gruppe.*
