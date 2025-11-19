# Wir nutzen ein stabiles Node-Image
FROM node:18-slim

# Arbeitsverzeichnis im Container erstellen
WORKDIR /app

# Wir müssen sicherstellen, dass Python und Build-Tools vorhanden sind (für sqlite3/gyp auf ARM)
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

# Zuerst kopieren wir nur die package Dateien (für besseres Caching)
COPY backend/package*.json ./backend/

# In den Backend-Ordner wechseln, um Installation durchzuführen
WORKDIR /app/backend

# Abhängigkeiten installieren
RUN npm install --production

# Jetzt kopieren wir den Rest des Codes (Frontend UND Backend)
WORKDIR /app
COPY frontend ./frontend
COPY backend ./backend

# Port freigeben
EXPOSE 3000

# Startbefehl (aus dem Backend-Verzeichnis heraus)
WORKDIR /app/backend
CMD ["node", "server.js"]