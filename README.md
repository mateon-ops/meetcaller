# MeetCaller (local)

Extensión Chrome (Manifest V3) que consulta una URL privada iCal (.ics) y muestra una ventana de "llamada entrante" cuando un evento del día está por comenzar.

Instalación rápida:

1. Abre `chrome://extensions` y activa "Developer mode".
2. Haz clic en "Load unpacked" y selecciona esta carpeta.
3. Abre el popup de la extensión y guarda la *Dirección privada en formato iCal* desde Google Calendar en la configuración de la extensión (puede añadirse manualmente usando `chrome.storage.local`).

Notas técnicas:
- El servicio en segundo plano (`background.js`) consulta la URL cada minuto (configurable) usando `chrome.alarms`.
- Usa un documento `offscreen.html` para reproducir audio localmente.
- `popup.html` muestra dos botones: "Atender" abre el link detectado, "Rechazar" cierra la ventana y detiene el audio.

Privacidad: toda la URL y la descarga del .ics quedan en tu navegador local; no se envía nada a servidores externos desde la extensión.

Antes este proyecto incluía un servidor de configuración local para facilitar el intercambio de tokens y configurar el iCal. La extensión ahora soporta guardar el `clientId`, `clientSecret` y los tokens directamente en `chrome.storage.local`, por lo que no es necesario ejecutar un servidor local. Si prefieres usar un servidor separado, puedes mantenerlo por tus propios medios.

Uso con Google Calendar API (OAuth)

Si la empresa no permite activar la Dirección privada iCal, la extensión puede usar la Google Calendar API mediante OAuth para leer tus eventos:

1. En Google Cloud Console crea un proyecto y activa la "Google Calendar API".
2. Crea credenciales -> OAuth client ID -> Application type: Chrome App. Para registrar el redirect deberás cargar la extensión y usar su ID.
3. Copia el `Client ID` y reemplaza `oauth2.client_id` en `manifest.json`.
4. En la página de opciones de la extensión activa "Usar Google Calendar API (OAuth)".

La extensión usará `chrome.identity.getAuthToken` para pedir permiso y consultar tus eventos desde la API oficial.
