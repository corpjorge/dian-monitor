# Desplegar el monitor de citas DIAN

Guía para desplegar este monitor desde cero, en una máquina o una cuenta que no
sea la original. Todo lo que hace falta saber está aquí; el `README.md` explica
el resto del proyecto.

## Cómo se ejecuta esto

El monitor vigila el portal de citas de la DIAN (`agendamiento.dian.gov.co`)
buscando cupo para una combinación fija: **Persona Natural → Videoatención →
Devoluciones**. Cuando aparece, avisa por Telegram a un grupo. Nunca agenda la
cita: sólo avisa.

Lo que más confunde al desplegarlo es esto: **el programa no se queda corriendo
ni lleva temporizador dentro**. Una ejecución de `npm run monitor` hace una sola
cosa —abrir el portal, recorrer el formulario, avisar si hay algo— y termina.
Lo dice su propio punto de entrada, en `src/index.ts`:

> *Entrypoint for a single run — start, check, notify if needed, exit.
> The process never stays resident.*

Devuelve `0` si la revisión se completó (haya cupo o no) y `1` si falló. Por
tanto **el ritmo de cada 5 minutos lo pone la plataforma, no el código**: un
cron, un `schedule`, un `launchd`. Si lo despliegas como un servicio web normal,
arrancará, revisará una vez, terminará, y la plataforma creerá que se cayó.

De ahí sale el primer criterio para elegir dónde alojarlo: tiene que saber
ejecutar tareas programadas. Railway y GitHub Actions lo hacen de forma nativa;
Fly.io y Render no tienen cron de 5 minutos y obligan a montar un bucle
alrededor del comando.

Una revisión completa tarda unos **4 segundos** y consume hasta **502 MB de
memoria** (Node más un Chromium real). Ese número decide el tamaño de máquina:
por debajo de 1 GB el sistema operativo puede matar la revisión a media
ejecución, sin dejar rastro ni aviso.

## Antes de empezar

El código está en `https://github.com/corpjorge/dian-monitor` (repositorio
público, rama `main`). No hace falta pedir acceso.

En tu equipo necesitas:

- **Node.js 20 o superior** y `npm`, sólo si vas a probarlo en local.
- **La CLI de Railway** (`npm i -g @railway/cli`) si despliegas ahí.
- **Git**.

No hace falta instalar Chromium: el `Dockerfile` parte de la imagen oficial de
Playwright, que ya lo trae con sus librerías de sistema y con la versión exacta
que espera el paquete `playwright` del `package.json`.

Y hay cuatro datos que **no viajan con el código** y tiene que darte el dueño
del proyecto:

| Dato | Por qué no está en el repo |
| --- | --- |
| Token del bot de Telegram | Es un secreto. El repositorio es público: si acaba en un commit, cualquiera controla el bot |
| `TELEGRAM_CHAT_IDS` (id del grupo) | Identifica el grupo privado donde llegan los avisos |
| Acceso a la cuenta donde se despliega | Railway, o la plataforma que se elija |
| Qué combinación vigilar | Hoy: Persona Natural / Videoatención / Devoluciones |

Pide el token por un canal privado, nunca por un chat de grupo ni por correo
compartido. Si prefieres no manejar el bot ajeno, crea uno propio con
**@BotFather** (`/newbot`), añádelo al grupo y usa `npm run telegram:setup` para
descubrir el `chat_id`: ese comando comprueba el token y lista los chats que el
bot conoce.

## Si quien despliega es un agente de IA

Puede hacerlo solo: clonar, instalar dependencias, crear proyecto y servicio,
cargar las variables, crear el volumen, desplegar, leer los logs y verificar.

Tiene que pedírselo a una persona:

1. **Autenticación.** `railway login` abre un navegador. Para trabajar sin él,
   la persona genera un token en Railway y se lo pasa como variable de entorno:
   `RAILWAY_API_TOKEN` para acciones de cuenta (crear el proyecto) o
   `RAILWAY_TOKEN` para actuar sobre un proyecto ya creado —
   `RAILWAY_API_TOKEN=xxx railway up`. También existe
   `railway login --browserless`, que imprime un código que la persona aprueba.
2. **El plan y la tarjeta.** Sin plan activo Railway no despliega, y eso no lo
   resuelve un agente.
3. **Lo que ocurre dentro de Telegram.** Crear el bot con @BotFather, crear el
   grupo y añadir a la gente exige una cuenta personal de Telegram. Con el token
   ya en la mano, en cambio, el agente sí puede descubrir el `chat_id`
   (`npm run telegram:setup`), cargar las variables y enviar el mensaje de
   prueba (`npm run telegram:setup -- --test`).

El propio CLI ofrece ayuda para esto: `railway setup agent -y` instala las
skills de Railway y su servidor MCP.

**Criterio de aceptación**, para saber cuándo ha terminado de verdad: en los
logs deben verse **dos ejecuciones consecutivas separadas cinco minutos**, ambas
acabando en `MONITOR_OK_...`, con el contador `ejecucion=N` subiendo entre una y
otra. Una sola ejecución correcta no prueba nada: significa que el despliegue
funcionó, no que quedara programado.

## Variables de entorno

Todo se configura por entorno; el código no lee `process.env` en ningún sitio
salvo en `src/config/env.ts`. Estas son las quince que hay que cargar:

| Variable | Valor | Nota |
| --- | --- | --- |
| `DIAN_URL` | `https://agendamiento.dian.gov.co/?recurso=CitasDIAN` | |
| `DIAN_TARGET_PERSON_TYPE` | `Persona Natural` | ⚠️ lleva espacio: compruébalo después de guardar |
| `DIAN_TARGET_ATTENTION_TYPE` | `Videoatención` | con tilde |
| `DIAN_TARGET_SERVICE` | `Devoluciones` | |
| `TELEGRAM_BOT_TOKEN` | *(secreto)* | te lo pasan aparte |
| `TELEGRAM_CHAT_IDS` | *(id del grupo, empieza por `-`)* | admite varios separados por coma |
| `TELEGRAM_SEND_SCREENSHOT` | `true` | adjunta la captura al aviso |
| `HEARTBEAT_EVERY_RUNS` | `50` | resumen «sigo vivo» cada 50 revisiones (~4 h) |
| `HEADLESS` | `true` | obligatorio en servidor |
| `DRY_RUN` | `false` | `true` = no envía nada; útil para la primera prueba |
| `NOTIFICATION_COOLDOWN_MINUTES` | `60` | |
| `SCREENSHOT_ON_ERROR` | `true` | |
| `LOG_LEVEL` | `info` | `debug` para diagnosticar |
| `STATE_BACKEND` | `json` | |
| `STATE_FILE_PATH` | `/app/data/state.json` | debe caer dentro del volumen |

Dos avisos por experiencia propia:

- **`DIAN_TARGET_PERSON_TYPE` contiene un espacio.** Si cargas las variables con
  un script que lee el `.env` desde el shell sin comillas, el valor llega
  partido (`Persona`) o vacío, y el monitor falla al no encontrar la opción. Ya
  pasó una vez. Después de cargarlas, verifica ese valor concreto.
- **Los valores llevan tildes** (`Videoatención`). El código normaliza tildes y
  mayúsculas al comparar, así que no es crítico, pero cópialos tal cual.

Si vas a probar en local, los mismos valores van en un `.env` en la raíz (hay un
`.env.example` de referencia). Ese fichero está en `.gitignore` y en
`.dockerignore`: nunca se sube ni entra en la imagen.

## Despliegue en Railway, paso a paso

Railway es la opción más directa porque tiene cron nativo y el repositorio ya
trae su configuración (`railway.json`). Cuesta unos **5 USD al mes** de plan
mínimo; no hay plan gratuito permanente (la prueba caduca y el servicio se
detiene).

```bash
# 1. Clonar y entrar
git clone https://github.com/corpjorge/dian-monitor.git
cd dian-monitor

# 2. Entrar en la cuenta (abre el navegador)
railway login

# 3. Crear el proyecto y el servicio
railway init --name dian-monitor
railway add --service monitor

# 4. Volumen para el estado (ver la sección siguiente)
railway volume add --mount-path /app/data
```

Las variables, una por una y **entrecomilladas** — es donde se cuela el error
del espacio:

```bash
railway variables \
  --set 'DIAN_URL=https://agendamiento.dian.gov.co/?recurso=CitasDIAN' \
  --set 'DIAN_TARGET_PERSON_TYPE=Persona Natural' \
  --set 'DIAN_TARGET_ATTENTION_TYPE=Videoatención' \
  --set 'DIAN_TARGET_SERVICE=Devoluciones' \
  --set 'TELEGRAM_BOT_TOKEN=EL_TOKEN_QUE_TE_PASARON' \
  --set 'TELEGRAM_CHAT_IDS=EL_ID_DEL_GRUPO' \
  --set 'TELEGRAM_SEND_SCREENSHOT=true' \
  --set 'HEARTBEAT_EVERY_RUNS=50' \
  --set 'HEADLESS=true' \
  --set 'DRY_RUN=false' \
  --set 'NOTIFICATION_COOLDOWN_MINUTES=60' \
  --set 'SCREENSHOT_ON_ERROR=true' \
  --set 'LOG_LEVEL=info' \
  --set 'STATE_BACKEND=json' \
  --set 'STATE_FILE_PATH=/app/data/state.json' \
  --skip-deploys

# Verifica el que suele romperse
railway variables --kv | grep PERSON_TYPE   # debe decir: Persona Natural
```

Y desplegar:

```bash
railway up --ci
```

Ese comando sube el directorio, construye con el `Dockerfile` y despliega. El
build incluye un `npm run typecheck`: si el código no compila, falla ahí y no
llega a producción. Tarda un par de minutos la primera vez, porque descarga la
imagen de Playwright.

## Las dos piezas que no son código

### La programación

En Railway viene del `railway.json` del repositorio, así que no hay que
configurarla a mano:

```json
"deploy": {
  "startCommand": "npm run monitor",
  "restartPolicyType": "NEVER",
  "cronSchedule": "*/5 * * * *"
}
```

`restartPolicyType: NEVER` es tan importante como el cron: sin él, Railway vería
un proceso que termina y lo reiniciaría en bucle, revisando el portal sin parar.

> Railway avisa de que la configuración en `railway.json` queda obsoleta y que
> hay que migrar a `.railway/railway.ts` (`railway config migrate`). Los ficheros
> actuales **siguen funcionando hasta el 1 de diciembre de 2026**.

En otra plataforma, esta pieza la pones tú: `schedule` en GitHub Actions,
`crontab`/`launchd` en un equipo propio, o un bucle
`while true; do npm run monitor; sleep 300; done` donde no haya cron.

### El estado

El monitor guarda un fichero pequeño (`state.json`) con la huella del último
aviso enviado y el contador de revisiones. Sirve para no repetir un aviso
idéntico y para saber cuándo toca el resumen periódico.

Ese fichero tiene que vivir en un **volumen persistente** montado en
`/app/data`, porque cada ejecución del cron arranca un contenedor nuevo. Sin
volumen, el monitor sigue avisando de los cupos —lo importante no se pierde—
pero cada revisión empieza de cero: el resumen periódico nunca llega y los
avisos repetidos pierden la coletilla de «es la misma disponibilidad». Con
500 MB sobra de largo.

## Cómo saber que quedó bien

No te fíes de que el despliegue diga «success»: eso sólo dice que la imagen se
construyó. Mira los logs de la primera revisión (`railway logs`). Una ejecución
sana se ve así:

```
INFO  Iniciando monitor DIAN  persona=Persona Natural modalidad=Videoatención servicio=Devoluciones
INFO  Portal cargado titulo=Agendamiento de Citas
INFO  Tipo de persona seleccionado: Persona Natural
INFO  Modalidad seleccionado: Videoatención
INFO  Tipo de servicio seleccionado: Devoluciones.
INFO  El portal informó que no hay especialidades para los filtros seleccionados
INFO  Ejecución finalizada en 4.2s
MONITOR_OK_NO_AVAILABILITY
```

Cuatro cosas que confirmar en ese texto:

1. La primera línea repite la configuración leída: comprueba que
   `persona=Persona Natural` está completo y que dice `telegram=1 chat(s)`. Si
   dice `telegram=deshabilitado`, faltan el token o el `chat_id`.
2. Termina con uno de estos marcadores: `MONITOR_OK_NO_AVAILABILITY`,
   `MONITOR_OK_AVAILABILITY_FOUND` o `MONITOR_ERROR`.
3. **Espera cinco minutos y confirma que hay una segunda ejecución.** Si no
   aparece, el cron no quedó programado: el despliegue funcionó pero sólo corrió
   una vez.
4. El contador `ejecucion=N` debe subir entre revisiones. Si siempre dice `1`,
   el volumen no está montado.

Para comprobar Telegram de punta a punta sin esperar a que haya cupo, despliega
una vez con `HEARTBEAT_EVERY_RUNS=1`: la siguiente revisión enviará al grupo el
mensaje «🔍 Sigo vigilando — sin cupo todavía» con su captura. Devuélvelo a `50`
después, o recibirás un mensaje cada cinco minutos.

## Si no se quiere pagar hosting

Se han comprobado los planes gratuitos de las opciones habituales y ninguno
sostiene esto de forma indefinida:

| Plataforma | Qué ofrece gratis | Por qué no sirve |
| --- | --- | --- |
| Railway | prueba temporal | caduca; al caducar, el cron se detiene y no admite despliegues |
| Fly.io | 2 horas de máquina o 7 días | las máquinas del trial se apagan solas a los 5 minutos; después exige tarjeta |
| Render | plan gratuito **permanente**, 512 MB | el plan Free no cubre cron jobs ni workers, sólo web services; y esos se apagan tras 15 minutos sin tráfico, sin disco persistente |

Quedan dos caminos que sí funcionan sin coste mensual:

**GitHub Actions.** El repositorio es público, y en repos públicos los minutos
de Actions son gratis e ilimitados. Un workflow con `on: schedule` cada 5
minutos ejecuta el monitor en un runner con 7 GB de RAM, con lo que el límite de
memoria desaparece. El token va en *Settings → Secrets and variables → Actions*.
Dos pegas reales: los `schedule` de GitHub **pueden retrasarse** en horas punta,
y GitHub **desactiva los schedules de repos públicos tras 60 días sin commits**
(avisa por correo y se reactivan con un clic).

**Un equipo propio.** Con `cron` en Linux o `launchd` en macOS, ejecutando
`npm run monitor` cada 5 minutos. Gratis, sin límites de memoria y sin
caducidad; sólo vigila mientras el equipo esté encendido y con red.

## Fallos conocidos

Todos estos ya ocurrieron; se reconocen por un síntoma concreto.

**«Your trial has expired» al desplegar en Railway.** No es un problema del
código: la cuenta no tiene plan activo. Hasta que se elija uno, ni despliega ni
ejecuta el cron. Cuando esto pasó, el monitor se quedó parado días sin que nadie
lo notara, porque un monitor que no corre no avisa de nada. Conviene revisar
cada tanto que hay ejecuciones recientes en los logs.

**Avisos falsos de «cita disponible».** Corregido en agosto de 2026. El portal
de la DIAN tarda a veces varios segundos y muestra una capa de carga
(`#mpcWPdivCargando`, la palabra «Cargando») o su pantalla de arranque. El
monitor concluía disponibilidad por *ausencia* del mensaje habitual, y una
pantalla a medio cargar se leía como si hubiera cupo. Ahora espera a que el
portal responda de verdad —el modal, o el control «Trámite» con opciones
reales— y si no llega ninguno en el tiempo límite, falla con
`PORTAL_NOT_SETTLED` y reintenta. **Si vuelven a aparecer avisos falsos, ahí
está el sitio donde mirar** (`src/dian/availability.ts`).

**Avisos duplicados.** Hay dos instancias corriendo contra el mismo grupo de
Telegram. Apaga una.

**`MONITOR_ERROR` repetido.** Mira la captura que guarda en `screenshots/` y el
mensaje del log. Si el portal cambió su interfaz, el error lo dirá
(`DIAN_STRUCTURE_CHANGED`) y listará las opciones que sí encontró; todo el
conocimiento del DOM está concentrado en `src/dian/selectors.ts`, que es el
único fichero que suele haber que tocar.

**CAPTCHA.** El monitor lo detecta y se detiene a propósito: no intenta
resolverlo. Si aparece, hay que mirarlo a mano.
