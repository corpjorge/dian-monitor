# Monitor de citas DIAN

Monitor automático de disponibilidad de citas en el portal de agendamiento de la
DIAN (Colombia): <https://agendamiento.dian.gov.co/>

Recorre el portal con un navegador real (Playwright + Chromium), comprueba si la
combinación que te interesa tiene cupo y te avisa por **Telegram, con captura de
pantalla**. Está pensado para no llenarte el chat: se calla mientras no hay
novedad y habla cuando importa —cuando aparece la cita, cuando algo se rompe, y
cada N ejecuciones para confirmar que sigue vivo—. Se ejecuta en Railway con
Cron, así que funciona aunque tu computador esté apagado.

El **correo (Resend) es opcional** y está desactivado por defecto; si lo
configuras, sólo se envía cuando hay disponibilidad real.

**El monitor no reserva citas.** Detecta, avisa y termina. No completa
formularios, no introduce datos personales y no intenta evadir ningún control de
seguridad.

---

## Contenido

- [Cómo funciona](#cómo-funciona)
- [Qué se descubrió del portal](#qué-se-descubrió-del-portal)
- [Instalación local](#instalación-local)
- [Configuración](#configuración)
- [Comandos](#comandos)
- [Detección de disponibilidad](#detección-de-disponibilidad)
- [Qué mensajes recibes](#qué-mensajes-recibes)
- [Control de duplicados](#control-de-duplicados)
- [Persistencia del estado](#persistencia-del-estado)
- [Despliegue en Railway](#despliegue-en-railway)
- [Diagnóstico cuando la DIAN cambia](#diagnóstico-cuando-la-dian-cambia)
- [Arquitectura](#arquitectura)
- [Límites y decisiones](#límites-y-decisiones)

---

## Cómo funciona

```
Railway Cron (cada 5 min)
        ↓
   Node.js + Playwright
        ↓
   Chromium abre el portal
        ↓
   Agendar cita → Tipo de persona → Modalidad → Tipo de servicio → …
        ↓
   ¿aparece el modal "No se encontraron especialidades…"?
        ↓
  SÍ → sin cupo                      NO → extrae fechas y horas si el flujo llega
        ↓                                        ↓
  ¿toca resumen (cada 50)?               🚨 Telegram "CITA DISPONIBLE" + captura
   NO → 🔇 silencio                         (+ correo si está configurado)
   SÍ → 🔍 Telegram resumen + captura              ↓
        MONITOR_OK_NO_AVAILABILITY               guarda estado
                                          MONITOR_OK_AVAILABILITY_FOUND
```

Cuándo recibes un mensaje:

| Situación | ¿Mensaje? |
| --- | --- |
| **Hay cita** | Siempre, al instante |
| **Sin cupo** | Sólo cada `HEARTBEAT_EVERY_RUNS` ejecuciones (50 por defecto) |
| **Empieza a fallar** | Sí, en el primer fallo |
| **Sigue fallando** | Se calla hasta el siguiente resumen |

El resumen periódico existe para que el silencio signifique una sola cosa: si
pasan más de N ejecuciones sin recibir nada, es que el cron dejó de correr.

Cada ejecución termina imprimiendo una de estas tres líneas, pensadas para
buscar en los logs de Railway:

| Marcador | Significado | Código de salida |
| --- | --- | --- |
| `MONITOR_OK_NO_AVAILABILITY` | Todo bien, no hay cita | 0 |
| `MONITOR_OK_AVAILABILITY_FOUND` | Todo bien, hay disponibilidad | 0 |
| `MONITOR_ERROR` | Falló la navegación, la configuración o apareció un CAPTCHA | 1 |

---

## Qué se descubrió del portal

Los selectores no se inventaron: se obtuvieron inspeccionando el sitio real con
Playwright. Vale la pena conocer estos detalles porque explican el diseño:

- El portal es una aplicación **ASP.NET WebForms** renderizada por el motor
  *C-Media WebPlayer* (Ciel Ingeniería), con widgets **Kendo UI**.
- **Hay que entrar con `?recurso=CitasDIAN`.** Sin ese parámetro la página se
  queda en el splash de carga indefinidamente.
- Cada control se envuelve en `<div rol="control" nombrecontrol="TipoPersona">`
  y el nodo interno lleva `pantalla="PasoUno"`. Son atributos **semánticos y
  estables**: mucho mejores que las clases CSS o las posiciones en pantalla.
- **Todas las pantallas coexisten en el DOM** (`PasoUno`, `PasoDos`,
  `ModalError`…) y sólo una es visible. Por eso todos los localizadores filtran
  por visibilidad.
- Se usan dos tipos de widget:
  - listas de botones → `<div class="boton" llave="<id>">`
  - desplegables nativos → `<select class="customSelect">`
- El texto de un botón puede llevar `<br>` (`Persona<br>Natural`), así que la
  comparación se hace sobre el texto visible normalizado, no sobre `textContent`.
- El botón «Siguiente» tiene dos variantes: `btnSiguientePaginaBlock`
  (bloqueado) y `btnSiguientePagina` (habilitado). Esperar al segundo es la
  señal de que la pantalla está completa.
- En el calendario Kendo los días **sin cupo** están deshabilitados y ocultos;
  los días con cupo son `td.k-calendar-td:not(.k-disabled)`.
- Las horas traen la fecha embebida en el `value`
  (`8/12/2026 12:15:00 PM`), lo que permite **verificar** que las horas leídas
  corresponden de verdad al día seleccionado.

### Catálogo de opciones (agosto 2026)

**Persona Natural + Videoatención**

| Tipo de servicio | ¿Tiene especialidades? |
| --- | --- |
| RUT y orientación TAC. | No |
| Conferencias o capacitaciones. | Sí |
| Devoluciones. | No |
| Autogestión servicios en línea con NAF. | Sí |
| Inconsistencias Grandes Contribuyentes. | No |
| Cobranzas. | No |
| Defensoría. | Sí |

**Persona Natural + Presencial**: RUT y orientación TAC · Aduanas · Cobranzas ·
Recaudo (Corrección inconsistencias) · Defensoría — todas con especialidades.

Esta tabla cambia con el tiempo. Usa `npm run inspect` para ver el estado actual.

---

## Instalación local

Requisitos: **Node.js 20 o superior**.

```bash
npm install
```

```bash
npm run playwright:install
```

```bash
cp .env.example .env
```

Edita `.env` con tus valores y prueba sin enviar nada:

```bash
npm run dev
```

`npm run dev` abre el navegador visible (`HEADLESS=false`) y activa `DRY_RUN`,
así que puedes ver todo el recorrido paso a paso sin gastar notificaciones.

---

## Configuración

Todo se controla por variables de entorno. El archivo
[`.env.example`](.env.example) documenta cada una; estas son las importantes.

### Qué vigilar

| Variable | Ejemplo | Notas |
| --- | --- | --- |
| `DIAN_TARGET_PERSON_TYPE` | `Persona Natural` | Obligatorio |
| `DIAN_TARGET_ATTENTION_TYPE` | `Videoatención` | Obligatorio |
| `DIAN_TARGET_SERVICE` | `Devoluciones` | «Seleccione el tipo de servicio» |
| `DIAN_TARGET_PROCEDURE` | *(vacío)* | El desplegable «Trámite» |
| `DIAN_TARGET_CITY` | `Bogotá, D.C.` | |
| `DIAN_TARGET_OFFICE` | `Bogotá Avenida 68` | |

Los valores se comparan **ignorando mayúsculas, tildes y el punto final**, así
que `Devoluciones` encuentra `Devoluciones.` sin problema.

**El recorrido se detiene en el primer valor vacío.** Es la forma de decir
«vigila sólo hasta aquí». Con la configuración de ejemplo el monitor recorre
`Persona Natural → Videoatención → Devoluciones` y evalúa ahí mismo. Si más
adelante quieres seguir hasta fecha y hora, rellena `DIAN_TARGET_PROCEDURE`,
`DIAN_TARGET_CITY` y `DIAN_TARGET_OFFICE`, y el monitor leerá el calendario y
las horas automáticamente. **No hay que tocar código para cambiar de objetivo.**

Para descubrir los textos exactos de cada nivel:

```bash
npm run inspect
```

### Notificaciones

| Variable | Por defecto | Notas |
| --- | --- | --- |
| `TELEGRAM_BOT_TOKEN` | — | Vacío = Telegram desactivado |
| `TELEGRAM_CHAT_IDS` | — | Varios chats separados por coma |
| `TELEGRAM_SEND_SCREENSHOT` | `true` | Adjunta la captura a cada mensaje |
| `HEARTBEAT_EVERY_RUNS` | `50` | Resumen cada N ejecuciones (`0` = nunca) |
| `RESEND_API_KEY` | — | Vacío = correo desactivado |
| `EMAIL_FROM` | — | Exige un **dominio propio verificado** en Resend |
| `EMAIL_TO` | — | Varios destinatarios separados por coma |

Los dos canales son independientes: si Resend falla, Telegram se envía igual, y
al revés. Pero tienen políticas distintas a propósito:

- **Telegram** avisa de cada cita y, además, envía un resumen cada
  `HEARTBEAT_EVERY_RUNS` ejecuciones.
- **El correo sólo se envía cuando hay disponibilidad**, nunca en las
  ejecuciones rutinarias: cientos de correos idénticos al día no le sirven a
  nadie.

> **Sobre el correo:** Resend exige un dominio propio verificado por DNS. No se
> puede enviar desde una dirección de Hotmail, Outlook o Gmail que no controles.
> Sin dominio puedes usar `EMAIL_FROM=onboarding@resend.dev`, pero entonces sólo
> entrega a la dirección con la que registraste tu cuenta de Resend. Por eso la
> configuración por defecto usa únicamente Telegram.

Para configurar Telegram:

1. Habla con [@BotFather](https://t.me/BotFather) → `/newbot` → copia el token
   en `TELEGRAM_BOT_TOKEN`.
2. Busca tu bot en Telegram y pulsa **Iniciar** (o escríbele `/start`).
   Este paso es obligatorio: **un bot no puede escribir primero**.
3. Ejecuta `npm run telegram:setup`: comprueba el token y te dice el
   `TELEGRAM_CHAT_IDS` exacto que debes pegar.
4. Comprueba que llega de verdad con `npm run telegram:setup -- --test`.

> El token da control total del bot. Si alguna vez se filtra (un pantallazo, un
> chat, un commit), revócalo con `/revoke` en @BotFather y pega el nuevo.

### Comportamiento

| Variable | Por defecto | Para qué sirve |
| --- | --- | --- |
| `HEADLESS` | `true` | `false` en local para ver el navegador |
| `DRY_RUN` | `false` | Recorre y muestra qué enviaría, sin enviarlo |
| `NOTIFICATION_COOLDOWN_MINUTES` | `60` | Mínimo entre alertas repetidas |
| `SCREENSHOT_ON_ERROR` | `true` | Captura + JSON de diagnóstico al fallar |
| `SCREENSHOT_ALWAYS` | `false` | Captura también en ejecuciones correctas |
| `LOG_LEVEL` | `info` | `debug` muestra el detalle completo |
| `MAX_ATTEMPTS` | `3` | Reintentos ante fallos temporales |
| `DIAN_SCAN_MONTHS` | `2` | Meses del calendario a revisar |

---

## Comandos

| Comando | Qué hace |
| --- | --- |
| `npm install` | Instala dependencias |
| `npm run playwright:install` | Descarga Chromium |
| `npm run monitor` | **Una** ejecución completa del monitor |
| `npm run dev` | Igual, con navegador visible y `DRY_RUN` |
| `npm run inspect` | Muestra las opciones reales del portal ahora mismo |
| `npm run telegram:setup` | Comprueba el bot y descubre tus `chat_id` |
| `npm run telegram:setup -- --test` | Además envía un mensaje de prueba |
| `npm test` | Tests unitarios |
| `npm run typecheck` | Verifica los tipos |
| `npm run build` | Compila a `dist/` |

---

## Detección de disponibilidad

`checkAvailability()` devuelve un objeto estructurado:

```jsonc
{
  "available": true,
  "detectedAt": "2026-08-10T04:00:00.000Z",
  "city": "Bogotá, D.C.",
  "procedure": "Inscripción o actualización RUT persona natural",
  "service": "RUT y orientación TAC",
  "attentionType": "Videoatención",
  "personType": "Persona Natural",
  "office": "Bogotá Avenida 68",
  "reason": "fechas-encontradas",
  "dates": [
    { "date": "2026-08-12", "label": "miércoles, 12 de agosto de 2026", "times": ["8:15 AM", "9:45 AM"] }
  ],
  "stepsCompleted": ["Tipo de persona=Persona Natural", "…"],
  "discoveredOptions": []
}
```

La detección **no busca la palabra «disponible»**. Se apoya en cómo responde
realmente la aplicación:

| Situación | `reason` | ¿Alerta? |
| --- | --- | --- |
| Aparece el modal `No se encontraron especialidades…` | `sin-especialidades` | No |
| Aparece **otro** mensaje en el modal | `mensaje-desconocido` | **Sí** |
| No aparece modal y el flujo avanza | `flujo-avanzo` | **Sí** |
| Se llega al calendario y hay días con cupo | `fechas-encontradas` | **Sí** |
| Se llega al calendario y no hay días | `sin-fechas-en-calendario` | No |

Es exactamente el criterio pedido: para `Persona Natural → Videoatención →
Devoluciones`, **cualquier cosa distinta a ese mensaje conocido genera alerta**.
El texto que cuenta como «sin disponibilidad» se puede cambiar con
`DIAN_NO_AVAILABILITY_MESSAGE`, por si la DIAN lo reescribe.

---

## Qué mensajes recibes

**Resumen periódico — sigue sin haber cupo** (cada 50 ejecuciones ≈ 4 horas)

```
🔍 Sigo vigilando — sin cupo todavía

👤 Persona Natural
💻 Videoatención
🗂 Devoluciones

💬 No se encontraron especialidades relacionadas según los filtros seleccionados.

🔁 50 revisiones sin novedad
Revisado: lunes, 10 de agosto de 2026, 04:35 a. m.
```

**Cuando aparece la cita** (siempre, sin esperar al resumen)

```
🚨 CITA DIAN DISPONIBLE

📍 Bogotá, D.C.
👤 Persona Natural
💻 Videoatención
🗂 RUT y orientación TAC
📋 Inscripción o actualización RUT persona natural
🏢 Bogotá Avenida 68

📅 miércoles, 12 de agosto de 2026
🕐 12:15 PM, 12:45 PM, 1:30 PM, …

Detectado: lunes, 10 de agosto de 2026, 12:35 a. m.
👉 https://agendamiento.dian.gov.co/
```

**Cuando el monitor empieza a fallar** (en el primer fallo, no a las 50 ejecuciones)

```
⚠️ El monitor no pudo completar la revisión

💬 El portal respondió HTTP 503.
```

Todos llevan adjunta la captura de la pantalla final.

Detalles de implementación que importan:

- La captura va como **foto con el texto de pie**, así que es un solo mensaje.
  Telegram limita el pie a 1024 caracteres: si el informe es más largo (muchas
  fechas y horas), se envía la foto y a continuación el texto completo, en vez
  de recortarlo en silencio.
- Si la foto falla (imagen corrupta, demasiado grande), **el texto se envía
  igual**. Una captura nunca cuesta la alerta.
- Cada chat se envía por separado: un `chat_id` equivocado no silencia al resto.
- En las ejecuciones silenciosas **ni siquiera se toma la captura**: no tiene
  sentido gastar el trabajo si nadie la va a ver.

### Ajustar el volumen de mensajes

| Qué quieres | Cómo |
| --- | --- |
| Resumen más espaciado | `HEARTBEAT_EVERY_RUNS=100` (≈8 h con cron de 5 min) |
| Resumen más frecuente | `HEARTBEAT_EVERY_RUNS=12` (≈1 h) |
| Un mensaje en cada ejecución | `HEARTBEAT_EVERY_RUNS=1` |
| **Sólo** avisar cuando haya cita | `HEARTBEAT_EVERY_RUNS=0` |
| Menos revisiones en total | `cronSchedule` a `*/15 * * * *` |
| Sólo en horario hábil | `*/10 7-18 * * 1-5` |
| Mensajes sin imagen | `TELEGRAM_SEND_SCREENSHOT=false` |

> ⚠️ **El resumen periódico necesita que el estado se conserve.** El contador de
> ejecuciones vive en `data/state.json`. En Railway los contenedores son
> efímeros: sin un **Volume** montado en `/app/data`, el contador se reinicia en
> cada ejecución y el resumen **nunca** se enviaría (los avisos de cita y de
> fallo sí seguirían funcionando). Ver
> [Persistencia del estado](#persistencia-del-estado). El monitor avisa en los
> logs si detecta que no puede conservar el contador.

---

## Control de duplicados

Dos protecciones combinadas:

1. **Huella SHA-256.** Se calcula sobre ciudad + sede + tipo de servicio +
   trámite + modalidad + tipo de persona + motivo + mensaje + fechas y horas
   (ordenadas). La misma disponibilidad produce la misma huella y no vuelve a
   avisar. Una fecha nueva, una hora nueva, otra sede o un mensaje distinto
   cambian la huella y **sí** avisan, aunque el enfriamiento esté activo.
2. **Enfriamiento.** `NOTIFICATION_COOLDOWN_MINUTES` marca cuánto debe pasar
   antes de tratar una alerta *idéntica* como novedad. Con `0` nunca se repite.

El aviso de cita se envía siempre, pero si la disponibilidad es la misma que ya
te avisamos, el mensaje lo dice explícitamente
(`ℹ️ Es la misma disponibilidad del aviso anterior`) en lugar de sonar como una
novedad.

---

## Persistencia del estado

La capa de almacenamiento está desacoplada tras la interfaz `StateStorage`
(`getLastState()` / `saveState()`), por lo que la lógica principal no sabe dónde
se guarda nada.

| Backend | `STATE_BACKEND` | Cuándo usarlo |
| --- | --- | --- |
| Archivo JSON | `json` | Local, o Railway **con volumen** |
| Memoria | `memory` | Tests y pruebas puntuales |

Para añadir Redis o PostgreSQL basta con crear una clase que implemente
`StateStorage` y registrarla en `src/storage/index.ts`. Nada más cambia.

### La opción más sencilla en Railway

Railway ejecuta contenedores efímeros: **el sistema de archivos se pierde entre
ejecuciones**. La opción más simple para conservar el estado es montar un
**Volume**:

1. En tu servicio → pestaña **Variables** → menú `⋮` → **Add Volume**.
2. Punto de montaje: `/app/data`.
3. Deja `STATE_BACKEND=json` y `STATE_FILE_PATH=data/state.json`.

**Sin volumen se pierden dos cosas:** el contador del resumen periódico (nunca
llegaría a 50, así que ese mensaje no se enviaría) y la memoria de qué
disponibilidad ya te avisamos. Los avisos de cita y de fallo siguen
funcionando en cualquier caso.

Si prefieres no montar volumen, pon `HEARTBEAT_EVERY_RUNS=0` para desactivar el
resumen y quedarte sólo con las alertas.

---

## Despliegue en Railway

### 1. Subir el proyecto a GitHub

```bash
git init && git add . && git commit -m "Monitor de citas DIAN"
```

```bash
git remote add origin https://github.com/TU_USUARIO/dian-monitor.git && git push -u origin main
```

`.env` está en `.gitignore`: los secretos nunca salen de tu máquina.

### 2. Crear el proyecto en Railway

1. Entra a [railway.app](https://railway.app) e inicia sesión con GitHub.
2. **New Project → Deploy from GitHub repo**.
3. Autoriza Railway y elige el repositorio.
4. Railway detecta el `Dockerfile` y `railway.json` automáticamente. La primera
   compilación tarda unos minutos (la imagen de Playwright es grande).

### 3. Configurar las variables de entorno

En el servicio → pestaña **Variables** → **Raw Editor**, pega tu configuración
(sin comentarios) y ajusta los valores:

```
DIAN_TARGET_PERSON_TYPE=Persona Natural
DIAN_TARGET_ATTENTION_TYPE=Videoatención
DIAN_TARGET_SERVICE=Devoluciones
RESEND_API_KEY=re_xxxxxxxxxxxx
EMAIL_FROM=Monitor DIAN <alertas@tudominio.com>
EMAIL_TO=correo1@gmail.com,correo2@hotmail.com
TELEGRAM_BOT_TOKEN=123456789:AAxxxxxxxxxxxxxxxxxxx
TELEGRAM_CHAT_IDS=111111111,222222222
HEADLESS=true
NOTIFICATION_COOLDOWN_MINUTES=60
```

Nunca escribas secretos en `railway.json`, en el `Dockerfile` ni en el
repositorio: van únicamente aquí.

### 4. Configurar el Cron

`railway.json` ya trae la programación:

```json
"cronSchedule": "*/5 * * * *",
"restartPolicyType": "NEVER"
```

Cada 5 minutos Railway arranca el contenedor, el monitor hace su comprobación y
el proceso termina. `restartPolicyType: NEVER` es imprescindible: sin él Railway
reiniciaría el contenedor en bucle al ver que el proceso terminó.

Con la configuración por defecto (`HEARTBEAT_EVERY_RUNS=50`) revisar cada 5
minutos son unos 6 mensajes al día más los avisos de cita. Si prefieres revisar
menos, usa `*/15 * * * *`, o `*/10 7-18 * * 1-5` para mirar sólo en horario
hábil, que es cuando la DIAN libera cupos.

También puedes ajustarlo desde la interfaz: servicio → **Settings** → **Cron
Schedule**. Ten en cuenta que Railway no lanza una nueva ejecución si la
anterior sigue viva; una ejecución normal tarda entre 10 y 70 segundos, así que
con 5 minutos hay margen de sobra.

### 5. Ver los logs

Servicio → pestaña **Deployments** → elige la ejecución → **View Logs**. Busca
la última línea:

```
MONITOR_OK_NO_AVAILABILITY
```

En el buscador de logs puedes filtrar por `MONITOR_` para ver de un vistazo el
historial de resultados, o por `MONITOR_ERROR` para revisar sólo los fallos.

### 6. Probar una ejecución manualmente

En la interfaz: servicio → menú `⋮` → **Redeploy**. Se ejecuta al instante sin
esperar al cron.

Con la CLI:

```bash
npm i -g @railway/cli && railway login && railway link
```

```bash
railway run npm run monitor
```

`railway run` usa las variables del proyecto pero ejecuta en tu máquina, lo cual
es ideal para comprobar la configuración antes de desplegar.

### 7. Actualizar el proyecto

```bash
git add . && git commit -m "Ajusta el trámite vigilado" && git push
```

Railway reconstruye y despliega solo. Si únicamente cambias **qué** se vigila,
no hace falta tocar el código: modifica las variables en Railway y el siguiente
cron ya usa los valores nuevos.

---

## Diagnóstico cuando la DIAN cambia

Ante un error de navegación el monitor guarda automáticamente en
`screenshots/`:

- `error-intentoN-<timestamp>.png` — la pantalla completa en el momento del fallo
- `error-intentoN-<timestamp>.json` — URL, título, texto visible, controles
  visibles y el mensaje de error

Los controles visibles son la pista más rápida: si `TipoPersona` desaparece de
esa lista, la DIAN renombró sus controles y hay que actualizar
[`src/dian/selectors.ts`](src/dian/selectors.ts) — que es el único archivo con
conocimiento del DOM.

No se guarda el HTML completo ni ningún dato personal.

### Si aparece un CAPTCHA

El portal incluye reCAPTCHA. Si en algún momento se activa, el monitor lo
**detecta, lo registra, toma la captura y se detiene** con `MONITOR_ERROR`.
No intenta resolverlo ni evadirlo: eso queda fuera del alcance de este proyecto
a propósito.

---

## Arquitectura

```
src/
├── index.ts                 Entrypoint: códigos de salida y marcadores de salud
├── monitor.ts               Orquestación: navegar → detectar → deduplicar → notificar
├── dian/
│   ├── selectors.ts         TODO el conocimiento del DOM vive aquí
│   ├── controls.ts          Widgets: listas de botones, selects, calendario, modal
│   ├── flow.ts              El recorrido como datos, construido desde la config
│   ├── navigator.ts         Control del navegador y esperas
│   └── availability.ts      Reglas de disponibilidad + huella SHA-256
├── notifications/
│   ├── messages.ts          Construcción de mensajes (funciones puras)
│   ├── email.ts             Resend
│   ├── telegram.ts          Bot API
│   ├── notifier.ts          Coordina los canales y aísla sus fallos
│   └── dedupe.ts            Huella + enfriamiento
├── storage/
│   ├── types.ts             Interfaz StateStorage
│   ├── json-file.ts         Escritura atómica (temporal + rename)
│   ├── memory.ts
│   └── index.ts             Fábrica según STATE_BACKEND
├── config/env.ts            Validación con zod; nadie más lee process.env
└── utils/                   logger, errors, retry, time, text, debug
```

**Errores diferenciados**: `ConfigurationError`, `NavigationError`,
`ElementNotFoundError`, `DianStructureChangedError`, `NotificationError`,
`CaptchaDetectedError`, `StorageError`. Sólo se reintentan los marcados como
temporales: si la estructura del portal cambió, reintentar no arregla nada y el
monitor lo dice claramente.

---

## Límites y decisiones

- **No reserva citas.** El monitor se detiene al detectar disponibilidad.
- **No evade CAPTCHA, reCAPTCHA, Cloudflare ni controles anti-bot.** Los detecta
  y se detiene.
- **No usa `mouse.click(x, y)`** para navegar. Todos los localizadores se apoyan
  en atributos semánticos (`nombrecontrol`, `llave`) y en el texto visible, así
  que un cambio de maquetación no rompe el recorrido.
- **No usa esperas fijas largas.** Se espera al elemento concreto, al estado de
  red o a que el widget confirme el cambio. Las únicas pausas cortas son las de
  sondeo entre comprobaciones.
- **Verifica lo que lee.** Al elegir una fecha comprueba que el widget la aceptó,
  y valida que las horas correspondan a ese día (la fecha viene dentro del
  `value` de cada opción). Sin esa comprobación el portal puede devolver las
  horas del día anterior y la alerta sería creíble pero falsa.
- **No imprime secretos.** Las API keys y los tokens se enmascaran en los logs.
- Se usa Playwright y no Selenium: mejores esperas automáticas, imagen Docker
  oficial con Chromium incluido y localizadores más robustos.
