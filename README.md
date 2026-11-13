# MeetCaller (local)

Extensión Chrome (Manifest V3) que consulta Google Calendar mediante OAuth y muestra una ventana de "llamada entrante" cuando una reunión está por comenzar.

Instalación rápida:

1. Abre `chrome://extensions` y activa "Developer mode".
2. Haz clic en "Load unpacked" y selecciona esta carpeta.
3. Abre la configuración de la extensión, ingresa el Google Client ID y completa el inicio de sesión.

Notas técnicas:
- El servicio en segundo plano (`background.js`) consulta Google Calendar cada minuto usando `chrome.alarms`.
- Usa un documento `offscreen.html` para reproducir audio localmente.
- `popup.html` muestra dos botones: "Atender" abre el link detectado, "Rechazar" cierra la ventana y detiene el audio.

Privacidad: los tokens de Google se guardan en el almacenamiento local de la extensión y se usan para consultar Google Calendar API.

La extensión guarda el `clientId`, el `clientSecret` (si se usa) y los tokens directamente en `chrome.storage.local`; no es necesario ejecutar un servidor local.

Uso con Google Calendar API (OAuth)

La extensión usa la Google Calendar API mediante OAuth para leer tus eventos:

1. En Google Cloud Console crea un proyecto y activa la "Google Calendar API".
2. Crea credenciales -> OAuth client ID -> Application type: Chrome App. Para registrar el redirect deberás cargar la extensión y usar su ID.
3. Ingresa el `Client ID` en las opciones de la extensión.
4. Inicia sesión con Google desde la página de opciones para autorizar el acceso al calendario.
