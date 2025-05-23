# Monitor de Dominancia USDT + Portfolio Tracker

Aplicación Node.js que monitorea la dominancia de USDT en el mercado de criptomonedas, envía alertas por Telegram y permite gestionar portfolios de trading con sistema de competición grupal.

## 📋 Funcionalidades

### 📊 Monitor USDT
- Obtiene datos del mercado cripto desde la API pública de CoinGecko
- Calcula la dominancia de USDT en tiempo real
- Envía alertas por Telegram cuando la dominancia está entre 3.6% y 3.85%
- Monitoreo automático cada hora
- Manejo robusto de errores

### 💼 Portfolio Tracker
- Sistema completo de gestión de carteras por usuario
- Búsqueda automática de monedas en CoinGecko
- Seguimiento de compras con precio promedio automático
- Registro de ventas con cálculo automático de profit/loss
- Precios en tiempo real para todas las monedas
- Sistema de competición y ranking entre usuarios
- Persistencia de datos en archivos JSON

## 🚀 Instalación

1. Clona o descarga este repositorio
2. Instala las dependencias:
```bash
npm install
```

3. Copia el archivo de ejemplo de variables de entorno:
```bash
cp .env.example .env
```

4. Configura las variables de entorno en el archivo `.env`:
```bash
TELEGRAM_BOT_TOKEN=tu_token_del_bot
TELEGRAM_CHAT_ID=tu_chat_id
```

## 🤖 Configuración del Bot de Telegram

### Crear un Bot

1. Habla con [@BotFather](https://t.me/botfather) en Telegram
2. Usa el comando `/newbot` y sigue las instrucciones
3. Guarda el token que te proporciona

### Obtener el Chat ID

1. Envía un mensaje a tu bot
2. Visita: `https://api.telegram.org/bot<TU_TOKEN>/getUpdates`
3. Busca el campo `"chat":{"id":123456789}` en la respuesta
4. Usa ese ID en la variable `TELEGRAM_CHAT_ID`

## ⚙️ Variables de Entorno

| Variable | Descripción | Requerida | Valor por defecto |
|----------|-------------|-----------|-------------------|
| `TELEGRAM_BOT_TOKEN` | Token del bot de Telegram | ✅ | - |
| `TELEGRAM_CHAT_ID` | ID del chat para enviar alertas | ✅ | - |
| `CHECK_INTERVAL_HOURS` | Intervalo de chequeo en horas | ❌ | 1 |
| `DOMINANCE_MIN_THRESHOLD` | Umbral mínimo de dominancia | ❌ | 3.6 |
| `DOMINANCE_MAX_THRESHOLD` | Umbral máximo de dominancia | ❌ | 3.85 |
| `SEND_INFO_MESSAGES` | Enviar mensajes informativos | ❌ | true |
| `ADMIN_IDS` | IDs de administradores separados por comas | ❌ | - |

## 🏃‍♂️ Ejecución

### Modo normal
```bash
npm start
```

### Modo desarrollo (mismo comportamiento)
```bash
npm run dev
```

## 📱 Comandos del Bot

### 📊 Monitoreo USDT
- `/status` - Ver dominancia actual de USDT
- `/config` - Ver configuración actual del bot
- `/help` - Mostrar todos los comandos disponibles

### 💼 Gestión de Portfolios

#### Crear y Gestionar Wallets
- `/create_wallet <nombre>` - Crear nueva wallet
- `/wallets` - Ver todas tus wallets
- `/wallet <nombre>` - Ver detalles de una wallet específica

#### Añadir Monedas
- `/add_coin <wallet> <moneda> <cantidad> [precio]` - Añadir moneda a wallet

**Ejemplos:**
```
/create_wallet main
/add_coin main btc 0.5 45000
/add_coin main eth 10 2500
/add_coin main sol 100
```

#### Registrar Ventas
- `/sell_coin <wallet> <moneda> <cantidad> <precio>` - Registrar venta

**Ejemplo:**
```
/sell_coin main btc 0.1 50000
```

#### Competición
- `/leaderboard` - Ver ranking de traders por profit

### 🔧 Comandos de Administrador (solo admins)
- `/set_interval <horas>` - Cambiar intervalo de monitoreo
- `/set_threshold <min> <max>` - Cambiar umbrales de alerta USDT
- `/toggle_messages` - Activar/desactivar mensajes informativos
- `/reload_config` - Recargar configuración

## 📊 Sistema de Portfolio

### 🪙 Gestión de Monedas
- **Búsqueda automática**: El bot busca automáticamente las monedas en CoinGecko
- **Precio promedio**: Calcula automáticamente el precio promedio de compra
- **Precios en tiempo real**: Obtiene precios actuales para calcular P&L

### 💰 Tracking de Profit/Loss
- **P&L realizado**: Profit de ventas ejecutadas
- **P&L no realizado**: Ganancia/pérdida actual basada en precios de mercado
- **Porcentajes**: Cálculo automático de porcentajes de ganancia

### 🏆 Sistema de Competición
- **Ranking global**: Leaderboard ordenado por profit total
- **Múltiples wallets**: Cada usuario puede tener varias carteras
- **Persistencia**: Todos los datos se guardan automáticamente

## 🔧 API Utilizada

- **CoinGecko API**: 
  - Global data: `https://api.coingecko.com/api/v3/global`
  - Precios: `https://api.coingecko.com/api/v3/simple/price`
  - Búsqueda: `https://api.coingecko.com/api/v3/search`
- Endpoint público, sin necesidad de API key
- Límite de tasa: ~50 requests/minuto

## 📝 Archivos de Datos

El bot crea automáticamente estos archivos:
- `bot-config.json` - Configuración persistente
- `portfolios.json` - Datos de portfolios de todos los usuarios

## 📊 Lógica de Alertas USDT

La aplicación enviará una alerta cuando:
- La dominancia de USDT sea **menor a 3.85%** 
- Y **mayor a 3.6%**
- Solo se envía una alerta por condición para evitar spam

## 🎯 Ejemplos de Uso Completo

### Configurar tu primera wallet:
```
/create_wallet trading
/add_coin trading btc 0.5 45000
/add_coin trading eth 10 2500
/wallet trading
```

### Registrar una venta exitosa:
```
/sell_coin trading btc 0.1 50000
/leaderboard
```

### Ver el estado general:
```
/wallets
/status
/config
```

## 🛑 Detener la aplicación

- `Ctrl + C` para detener el proceso
- La aplicación maneja las señales de terminación de forma limpia

## 🏗️ Estructura del Proyecto

```
wallet-monitor/
├── bot.js              # Lógica principal + portfolio tracker
├── package.json        # Dependencias y scripts
├── .env.example        # Ejemplo de variables de entorno
├── .env                # Variables de entorno (crear manualmente)
├── bot-config.json     # Configuración persistente (auto-generado)
├── portfolios.json     # Datos de portfolios (auto-generado)
└── README.md           # Documentación
```

## 🐛 Solución de Problemas

### Error: "TELEGRAM_BOT_TOKEN no configurado"
- Verifica que el archivo `.env` existe y contiene el token válido

### Error de conexión a CoinGecko
- Verifica tu conexión a internet
- CoinGecko puede tener límites de tasa - espera unos minutos

### No recibo alertas en Telegram
- Verifica que el `CHAT_ID` sea correcto
- Asegúrate de haber enviado al menos un mensaje al bot primero

### No encuentra una moneda
- Usa el símbolo oficial (ej: btc, eth, sol)
- Prueba con el nombre completo (ej: bitcoin, ethereum)

### Error al guardar portfolios
- Verifica que el bot tenga permisos de escritura en el directorio

## 📄 Licencia

MIT
