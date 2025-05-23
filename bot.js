require("dotenv").config();
const TelegramBot = require("node-telegram-bot-api");
const axios = require("axios");
const fs = require("fs");
const path = require("path");

// Configuración desde variables de entorno
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
let CHECK_INTERVAL_HOURS = parseInt(process.env.CHECK_INTERVAL_HOURS) || 1;
let DOMINANCE_MIN_THRESHOLD =
    parseFloat(process.env.DOMINANCE_MIN_THRESHOLD) || 3.6;
let DOMINANCE_MAX_THRESHOLD =
    parseFloat(process.env.DOMINANCE_MAX_THRESHOLD) || 3.85;
let SEND_INFO_MESSAGES = process.env.SEND_INFO_MESSAGES !== "false";

// Administradores del bot (pueden cambiar configuración)
const ADMIN_IDS = process.env.ADMIN_IDS
    ? process.env.ADMIN_IDS.split(",").map((id) => parseInt(id.trim()))
    : [];

const COINGECKO_API_URL = "https://api.coingecko.com/api/v3/global";
const COINGECKO_PRICE_URL = "https://api.coingecko.com/api/v3/simple/price";
const COINGECKO_SEARCH_URL = "https://api.coingecko.com/api/v3/search";

// Archivo para persistir configuración y portfolios
const CONFIG_FILE = path.join(__dirname, "bot-config.json");
const PORTFOLIO_FILE = path.join(__dirname, "portfolios.json");

let bot;
if (TELEGRAM_BOT_TOKEN) {
    bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });
} else {
    console.warn(
        "⚠️ TELEGRAM_BOT_TOKEN no configurado. Las alertas no se enviarán."
    );
}

// Variables de estado
let lastDominance = null;
let lastAlertSent = false;
let monitoringInterval = null;
let isFirstRun = true;

// === GESTIÓN DE PORTFOLIOS ===

// Cargar portfolios
function loadPortfolios() {
    try {
        if (fs.existsSync(PORTFOLIO_FILE)) {
            const data = fs.readFileSync(PORTFOLIO_FILE, "utf8");
            return JSON.parse(data);
        }
        return { users: {} };
    } catch (error) {
        console.warn("⚠️ Error al cargar portfolios:", error.message);
        return { users: {} };
    }
}

// Guardar portfolios
function savePortfolios(data) {
    try {
        fs.writeFileSync(PORTFOLIO_FILE, JSON.stringify(data, null, 2));
        console.log("💾 Portfolios guardados");
    } catch (error) {
        console.warn("⚠️ Error al guardar portfolios:", error.message);
    }
}

// Obtener o crear usuario
function getUser(userId, username = null) {
    const portfolios = loadPortfolios();
    if (!portfolios.users[userId]) {
        portfolios.users[userId] = {
            username: username || `user_${userId}`,
            wallets: {},
            total_profit: 0,
            total_invested: 0,
        };
        savePortfolios(portfolios);
    }
    return portfolios.users[userId];
}

// Buscar moneda en CoinGecko
async function searchCoin(query) {
    try {
        const response = await axios.get(COINGECKO_SEARCH_URL, {
            params: { query: query },
            timeout: 5000,
        });

        const coins = response.data.coins || [];
        if (coins.length === 0) {
            return null;
        }

        // Buscar coincidencia exacta primero
        const exactMatch = coins.find(
            (coin) =>
                coin.symbol.toLowerCase() === query.toLowerCase() ||
                coin.id.toLowerCase() === query.toLowerCase()
        );

        return exactMatch || coins[0];
    } catch (error) {
        console.error("❌ Error al buscar moneda:", error.message);
        return null;
    }
}

// Obtener precios de CoinGecko
async function getCoinPrices(coinIds) {
    try {
        if (!coinIds || coinIds.length === 0) return {};

        const response = await axios.get(COINGECKO_PRICE_URL, {
            params: {
                ids: coinIds.join(","),
                vs_currencies: "usd",
            },
            timeout: 10000,
        });

        return response.data;
    } catch (error) {
        console.error("❌ Error al obtener precios:", error.message);
        return {};
    }
}

// Formatear número con separadores
function formatNumber(num, decimals = 2) {
    if (num === 0) return "0";
    if (Math.abs(num) < 0.01) return num.toExponential(2);
    return num.toLocaleString("en-US", {
        minimumFractionDigits: decimals,
        maximumFractionDigits: decimals,
    });
}

// Calcular profit total de un usuario
function calculateUserProfit(user) {
    let totalProfit = 0;

    Object.values(user.wallets).forEach((wallet) => {
        Object.values(wallet.coins || {}).forEach((coin) => {
            if (coin.sales) {
                coin.sales.forEach((sale) => {
                    totalProfit += sale.profit || 0;
                });
            }
        });
    });

    return totalProfit;
}

// === COMANDOS DE PORTFOLIO ===

// Comando para crear wallet
async function handleCreateWallet(msg, match) {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const username = msg.from.username || msg.from.first_name || "Usuario";

    if (!match || !match[1]) {
        await bot.sendMessage(
            chatId,
            "❌ Uso: `/create_wallet <nombre>`\n\nEjemplo: `/create_wallet main`",
            { parse_mode: "Markdown" }
        );
        return;
    }

    const walletName = match[1].toLowerCase().trim();

    if (walletName.length < 2 || walletName.length > 20) {
        await bot.sendMessage(
            chatId,
            "❌ El nombre de la wallet debe tener entre 2 y 20 caracteres"
        );
        return;
    }

    const portfolios = loadPortfolios();
    const user = getUser(userId, username);

    if (user.wallets[walletName]) {
        await bot.sendMessage(
            chatId,
            `❌ Ya tienes una wallet llamada "${walletName}"`
        );
        return;
    }

    user.wallets[walletName] = {
        name: walletName,
        coins: {},
        created: new Date().toISOString(),
    };

    portfolios.users[userId] = user;
    savePortfolios(portfolios);

    await bot.sendMessage(
        chatId,
        `✅ Wallet "${walletName}" creada exitosamente!\n\nUsa \`/add_coin ${walletName} <moneda> <cantidad> [precio_compra]\` para añadir monedas`,
        { parse_mode: "Markdown" }
    );
}

// Comando para añadir moneda
async function handleAddCoin(msg, match) {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const username = msg.from.username || msg.from.first_name || "Usuario";

    if (!match || match.length < 4) {
        await bot.sendMessage(
            chatId,
            "❌ Uso: `/add_coin <wallet> <moneda> <cantidad> [precio_compra]`\n\nEjemplo: `/add_coin main btc 0.5 45000`",
            { parse_mode: "Markdown" }
        );
        return;
    }

    const walletName = match[1].toLowerCase().trim();
    const coinSymbol = match[2].toLowerCase().trim();
    const amount = parseFloat(match[3]);
    const buyPrice = match[4] ? parseFloat(match[4]) : null;

    if (isNaN(amount) || amount <= 0) {
        await bot.sendMessage(
            chatId,
            "❌ La cantidad debe ser un número positivo"
        );
        return;
    }

    if (buyPrice !== null && (isNaN(buyPrice) || buyPrice <= 0)) {
        await bot.sendMessage(
            chatId,
            "❌ El precio de compra debe ser un número positivo"
        );
        return;
    }

    const portfolios = loadPortfolios();
    const user = getUser(userId, username);

    if (!user.wallets[walletName]) {
        await bot.sendMessage(
            chatId,
            `❌ No tienes una wallet llamada "${walletName}". Usa \`/create_wallet ${walletName}\` primero`,
            { parse_mode: "Markdown" }
        );
        return;
    }

    // Buscar moneda en CoinGecko
    await bot.sendMessage(chatId, `🔍 Buscando ${coinSymbol.toUpperCase()}...`);

    const coinInfo = await searchCoin(coinSymbol);
    if (!coinInfo) {
        await bot.sendMessage(
            chatId,
            `❌ No se encontró la moneda "${coinSymbol}" en CoinGecko`
        );
        return;
    }

    const wallet = user.wallets[walletName];
    const coinId = coinInfo.id;

    if (!wallet.coins[coinId]) {
        wallet.coins[coinId] = {
            symbol: coinInfo.symbol.toUpperCase(),
            name: coinInfo.name,
            amount: 0,
            total_invested: 0,
            avg_buy_price: 0,
            sales: [],
        };
    }

    const coin = wallet.coins[coinId];

    // Calcular nuevo precio promedio
    if (buyPrice !== null) {
        const currentValue = coin.amount * coin.avg_buy_price;
        const newInvestment = amount * buyPrice;
        const totalAmount = coin.amount + amount;

        coin.avg_buy_price =
            totalAmount > 0 ? (currentValue + newInvestment) / totalAmount : 0;
        coin.total_invested += newInvestment;
    }

    coin.amount += amount;

    portfolios.users[userId] = user;
    savePortfolios(portfolios);

    const priceText = buyPrice !== null ? ` a $${formatNumber(buyPrice)}` : "";
    await bot.sendMessage(
        chatId,
        `✅ Añadidas ${formatNumber(amount, 6)} ${
            coin.symbol
        }${priceText} a la wallet "${walletName}"\n\n💰 Total ${
            coin.symbol
        }: ${formatNumber(coin.amount, 6)}\n📊 Precio promedio: $${formatNumber(
            coin.avg_buy_price
        )}`
    );
}

// Comando para vender moneda
async function handleSellCoin(msg, match) {
    const chatId = msg.chat.id;
    const userId = msg.from.id;

    if (!match || match.length < 5) {
        await bot.sendMessage(
            chatId,
            "❌ Uso: `/sell_coin <wallet> <moneda> <cantidad> <precio_venta>`\n\nEjemplo: `/sell_coin main btc 0.1 50000`",
            { parse_mode: "Markdown" }
        );
        return;
    }

    const walletName = match[1].toLowerCase().trim();
    const coinSymbol = match[2].toLowerCase().trim();
    const amount = parseFloat(match[3]);
    const sellPrice = parseFloat(match[4]);

    if (isNaN(amount) || amount <= 0) {
        await bot.sendMessage(
            chatId,
            "❌ La cantidad debe ser un número positivo"
        );
        return;
    }

    if (isNaN(sellPrice) || sellPrice <= 0) {
        await bot.sendMessage(
            chatId,
            "❌ El precio de venta debe ser un número positivo"
        );
        return;
    }

    const portfolios = loadPortfolios();
    const user = portfolios.users[userId];

    if (!user || !user.wallets[walletName]) {
        await bot.sendMessage(
            chatId,
            `❌ No tienes una wallet llamada "${walletName}"`
        );
        return;
    }

    // Buscar moneda
    const coinInfo = await searchCoin(coinSymbol);
    if (!coinInfo) {
        await bot.sendMessage(
            chatId,
            `❌ No se encontró la moneda "${coinSymbol}"`
        );
        return;
    }

    const wallet = user.wallets[walletName];
    const coin = wallet.coins[coinInfo.id];

    if (!coin || coin.amount < amount) {
        await bot.sendMessage(
            chatId,
            `❌ No tienes suficientes ${coinSymbol.toUpperCase()} en esa wallet\nDisponible: ${
                coin ? formatNumber(coin.amount, 6) : "0"
            }`
        );
        return;
    }

    // Calcular profit
    const costBasis = amount * coin.avg_buy_price;
    const saleValue = amount * sellPrice;
    const profit = saleValue - costBasis;
    const profitPercent = costBasis > 0 ? (profit / costBasis) * 100 : 0;

    // Registrar venta
    coin.sales.push({
        amount: amount,
        price: sellPrice,
        cost_basis: coin.avg_buy_price,
        profit: profit,
        profit_percent: profitPercent,
        date: new Date().toISOString(),
    });

    // Actualizar cantidad
    coin.amount -= amount;
    coin.total_invested -= costBasis;

    // Actualizar profit total del usuario
    user.total_profit = calculateUserProfit(user);

    portfolios.users[userId] = user;
    savePortfolios(portfolios);

    const profitEmoji = profit >= 0 ? "📈" : "��";
    const profitColor = profit >= 0 ? "✅" : "❌";

    await bot.sendMessage(
        chatId,
        `${profitColor} *Venta registrada*\n\n` +
            `💰 ${formatNumber(amount, 6)} ${
                coin.symbol
            } vendidas a $${formatNumber(sellPrice)}\n` +
            `📊 Precio promedio de compra: $${formatNumber(
                coin.avg_buy_price
            )}\n` +
            `${profitEmoji} Profit: $${formatNumber(profit)} (${formatNumber(
                profitPercent,
                2
            )}%)\n\n` +
            `💼 Cantidad restante: ${formatNumber(coin.amount, 6)} ${
                coin.symbol
            }`,
        { parse_mode: "Markdown" }
    );
}

// Comando para ver wallet específica
async function handleViewWallet(msg, match) {
    const chatId = msg.chat.id;
    const userId = msg.from.id;

    if (!match || !match[1]) {
        await bot.sendMessage(
            chatId,
            "❌ Uso: `/wallet <nombre>`\n\nEjemplo: `/wallet main`",
            { parse_mode: "Markdown" }
        );
        return;
    }

    const walletName = match[1].toLowerCase().trim();
    const portfolios = loadPortfolios();
    const user = portfolios.users[userId];

    if (!user || !user.wallets[walletName]) {
        await bot.sendMessage(
            chatId,
            `❌ No tienes una wallet llamada "${walletName}"`
        );
        return;
    }

    const wallet = user.wallets[walletName];
    const coins = Object.values(wallet.coins || {});

    if (coins.length === 0) {
        await bot.sendMessage(
            chatId,
            `📁 Wallet "${walletName}" está vacía\n\nUsa \`/add_coin ${walletName} <moneda> <cantidad>\` para añadir monedas`,
            { parse_mode: "Markdown" }
        );
        return;
    }

    // Obtener precios actuales
    const coinIds = Object.keys(wallet.coins);
    await bot.sendMessage(chatId, "🔄 Obteniendo precios actuales...");

    const prices = await getCoinPrices(coinIds);

    let message = `💼 *Wallet: ${walletName}*\n\n`;
    let totalValue = 0;
    let totalInvested = 0;

    for (const [coinId, coin] of Object.entries(wallet.coins)) {
        const currentPrice = prices[coinId]?.usd || 0;
        const currentValue = coin.amount * currentPrice;
        const unrealizedPnL = currentValue - coin.total_invested;
        const unrealizedPercent =
            coin.total_invested > 0
                ? (unrealizedPnL / coin.total_invested) * 100
                : 0;

        totalValue += currentValue;
        totalInvested += coin.total_invested;

        const pnlEmoji = unrealizedPnL >= 0 ? "📈" : "📉";

        message += `🪙 *${coin.symbol}* (${coin.name})\n`;
        message += `   �� Cantidad: ${formatNumber(coin.amount, 6)}\n`;
        message += `   💵 Precio actual: $${formatNumber(currentPrice)}\n`;
        message += `   📊 Precio promedio: $${formatNumber(
            coin.avg_buy_price
        )}\n`;
        message += `   💎 Valor actual: $${formatNumber(currentValue)}\n`;
        message += `   ${pnlEmoji} P&L: $${formatNumber(
            unrealizedPnL
        )} (${formatNumber(unrealizedPercent, 2)}%)\n\n`;
    }

    const totalPnL = totalValue - totalInvested;
    const totalPercent =
        totalInvested > 0 ? (totalPnL / totalInvested) * 100 : 0;
    const totalEmoji = totalPnL >= 0 ? "📈" : "📉";

    message += `━━━━━━━━━━━━━━━━━\n`;
    message += `💼 *Total invertido:* $${formatNumber(totalInvested)}\n`;
    message += `💎 *Valor actual:* $${formatNumber(totalValue)}\n`;
    message += `${totalEmoji} *P&L Total:* $${formatNumber(
        totalPnL
    )} (${formatNumber(totalPercent, 2)}%)`;

    await bot.sendMessage(chatId, message, { parse_mode: "Markdown" });
}

// Comando para ver todas las wallets del usuario
async function handleViewWallets(msg) {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const portfolios = loadPortfolios();
    const user = portfolios.users[userId];

    if (!user || Object.keys(user.wallets).length === 0) {
        await bot.sendMessage(
            chatId,
            "📁 No tienes wallets creadas\n\nUsa `/create_wallet <nombre>` para crear tu primera wallet",
            { parse_mode: "Markdown" }
        );
        return;
    }

    let message = `💼 *Tus Wallets*\n\n`;

    for (const [walletName, wallet] of Object.entries(user.wallets)) {
        const coinCount = Object.keys(wallet.coins || {}).length;
        message += `📁 *${walletName}* - ${coinCount} moneda(s)\n`;
    }

    message += `\n🎯 Profit total realizado: $${formatNumber(
        user.total_profit
    )}\n\n`;
    message += `Usa \`/wallet <nombre>\` para ver detalles`;

    await bot.sendMessage(chatId, message, { parse_mode: "Markdown" });
}

// Comando para leaderboard
async function handleLeaderboard(msg) {
    const chatId = msg.chat.id;
    const portfolios = loadPortfolios();

    const users = Object.values(portfolios.users)
        .filter((user) => Object.keys(user.wallets).length > 0)
        .map((user) => ({
            ...user,
            total_profit: calculateUserProfit(user),
        }))
        .sort((a, b) => b.total_profit - a.total_profit);

    if (users.length === 0) {
        await bot.sendMessage(
            chatId,
            "📊 No hay usuarios con portfolios creados aún"
        );
        return;
    }

    let message = `🏆 *Leaderboard de Trading*\n\n`;

    users.forEach((user, index) => {
        const emoji =
            index === 0 ? "🥇" : index === 1 ? "🥈" : index === 2 ? "🥉" : "🔸";
        const profitEmoji = user.total_profit >= 0 ? "📈" : "📉";

        message += `${emoji} *${user.username}*\n`;
        message += `   ${profitEmoji} Profit: $${formatNumber(
            user.total_profit
        )}\n`;
        message += `   📁 Wallets: ${Object.keys(user.wallets).length}\n\n`;
    });

    await bot.sendMessage(chatId, message, { parse_mode: "Markdown" });
}

// === CÓDIGO EXISTENTE ===

// Cargar configuración persistente
function loadConfig() {
    try {
        if (fs.existsSync(CONFIG_FILE)) {
            const config = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
            CHECK_INTERVAL_HOURS =
                config.CHECK_INTERVAL_HOURS || CHECK_INTERVAL_HOURS;
            DOMINANCE_MIN_THRESHOLD =
                config.DOMINANCE_MIN_THRESHOLD || DOMINANCE_MIN_THRESHOLD;
            DOMINANCE_MAX_THRESHOLD =
                config.DOMINANCE_MAX_THRESHOLD || DOMINANCE_MAX_THRESHOLD;
            SEND_INFO_MESSAGES =
                config.SEND_INFO_MESSAGES !== undefined
                    ? config.SEND_INFO_MESSAGES
                    : SEND_INFO_MESSAGES;
            console.log("📄 Configuración cargada desde archivo");
        }
    } catch (error) {
        console.warn("⚠️ Error al cargar configuración:", error.message);
    }
}

// Guardar configuración
function saveConfig() {
    try {
        const config = {
            CHECK_INTERVAL_HOURS,
            DOMINANCE_MIN_THRESHOLD,
            DOMINANCE_MAX_THRESHOLD,
            SEND_INFO_MESSAGES,
        };
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
        console.log("💾 Configuración guardada");
    } catch (error) {
        console.warn("⚠️ Error al guardar configuración:", error.message);
    }
}

// Verificar si usuario es administrador
function isAdmin(userId) {
    return ADMIN_IDS.length === 0 || ADMIN_IDS.includes(userId);
}

async function getGlobalMarketData() {
    try {
        console.log("📊 Obteniendo datos del mercado...");
        const response = await axios.get(COINGECKO_API_URL, {
            timeout: 10000,
            headers: {
                Accept: "application/json",
                "User-Agent": "wallet-monitor/1.0",
            },
        });

        return response.data.data;
    } catch (error) {
        console.error("❌ Error al obtener datos de CoinGecko:", error.message);
        if (error.response) {
            console.error(
                "📄 Respuesta del servidor:",
                error.response.status,
                error.response.statusText
            );
        }
        throw error;
    }
}

function calculateUSDTDominance(marketData) {
    const totalMarketCap = marketData.total_market_cap?.usd;
    const usdtMarketCap = marketData.market_cap_percentage?.usdt;

    if (!totalMarketCap || usdtMarketCap === undefined) {
        throw new Error(
            "Datos de market cap no disponibles en la respuesta de la API"
        );
    }

    return {
        dominance: usdtMarketCap,
        totalMarketCap: totalMarketCap,
        usdtMarketCapUSD: (totalMarketCap * usdtMarketCap) / 100,
    };
}

async function sendTelegramInfo(
    dominance,
    totalMarketCap,
    usdtMarketCapUSD,
    isAlert = false,
    chatId = null
) {
    if (!bot) {
        console.warn("⚠️ Bot de Telegram no configurado correctamente");
        return false;
    }

    const targetChatId = chatId || TELEGRAM_CHAT_ID;
    if (!targetChatId) {
        console.warn("⚠️ Chat ID no especificado");
        return false;
    }

    let message;

    if (isAlert) {
        message = `🚨 *ALERTA DOMINANCIA USDT*

📊 *Dominancia actual:* ${dominance.toFixed(3)}%
💰 *Market Cap Total:* $${(totalMarketCap / 1e12).toFixed(2)}T
💵 *Market Cap USDT:* $${(usdtMarketCapUSD / 1e9).toFixed(2)}B

⚡ La dominancia de USDT ha caído por debajo de ${DOMINANCE_MAX_THRESHOLD}% pero se mantiene por encima de ${DOMINANCE_MIN_THRESHOLD}%

📅 ${new Date().toLocaleString("es-ES", { timeZone: "UTC" })} UTC`;
    } else {
        let statusIcon = "📊";
        let statusText = "Normal";

        if (
            dominance < DOMINANCE_MAX_THRESHOLD &&
            dominance > DOMINANCE_MIN_THRESHOLD
        ) {
            statusIcon = "⚠️";
            statusText = "En rango de alerta";
        } else if (dominance >= DOMINANCE_MAX_THRESHOLD) {
            statusIcon = "📈";
            statusText = "Por encima del umbral";
        } else if (dominance <= DOMINANCE_MIN_THRESHOLD) {
            statusIcon = "📉";
            statusText = "Por debajo del mínimo";
        }

        message = `${statusIcon} *Monitor USDT*

📊 *Dominancia:* ${dominance.toFixed(3)}%
💰 *Market Cap Total:* $${(totalMarketCap / 1e12).toFixed(2)}T
💵 *Market Cap USDT:* $${(usdtMarketCapUSD / 1e9).toFixed(2)}B

📈 *Estado:* ${statusText}
🎯 *Rango objetivo:* ${DOMINANCE_MIN_THRESHOLD}% - ${DOMINANCE_MAX_THRESHOLD}%

📅 ${new Date().toLocaleString("es-ES", { timeZone: "UTC" })} UTC`;
    }

    try {
        await bot.sendMessage(targetChatId, message, {
            parse_mode: "Markdown",
        });
        console.log(`✅ ${isAlert ? "Alerta" : "Info"} enviada por Telegram`);
        return true;
    } catch (error) {
        console.error("❌ Error al enviar mensaje de Telegram:", error.message);
        return false;
    }
}

async function checkUSDTDominance(isManual = false, chatId = null) {
    try {
        console.log(
            `\n🔍 Iniciando chequeo de dominancia USDT - ${new Date().toLocaleString(
                "es-ES"
            )}`
        );

        const marketData = await getGlobalMarketData();
        const { dominance, totalMarketCap, usdtMarketCapUSD } =
            calculateUSDTDominance(marketData);

        console.log(`💹 Dominancia USDT: ${dominance.toFixed(3)}%`);
        console.log(
            `💰 Market Cap Total: $${(totalMarketCap / 1e12).toFixed(2)}T`
        );
        console.log(
            `💵 Market Cap USDT: $${(usdtMarketCapUSD / 1e9).toFixed(2)}B`
        );

        const shouldAlert =
            dominance < DOMINANCE_MAX_THRESHOLD &&
            dominance > DOMINANCE_MIN_THRESHOLD;

        // Si es consulta manual, siempre enviar respuesta
        if (isManual) {
            await sendTelegramInfo(
                dominance,
                totalMarketCap,
                usdtMarketCapUSD,
                false,
                chatId
            );
            return { dominance, totalMarketCap, usdtMarketCapUSD };
        }

        // No enviar mensajes informativos en el primer chequeo después del reinicio
        if (isFirstRun) {
            console.log(
                "🔇 Primer chequeo después del reinicio - sin enviar mensajes"
            );
            isFirstRun = false;
        } else {
            // Enviar mensaje informativo en chequeos automáticos posteriores
            if (SEND_INFO_MESSAGES) {
                await sendTelegramInfo(
                    dominance,
                    totalMarketCap,
                    usdtMarketCapUSD,
                    false
                );
            }
        }

        // Verificar si debe enviar alerta especial (solo si no es el primer chequeo)
        if (shouldAlert && !isFirstRun) {
            const significantChange =
                lastDominance === null ||
                Math.abs(dominance - lastDominance) > 0.05;

            if (!lastAlertSent || significantChange) {
                console.log(
                    `🚨 ¡CONDICIÓN DE ALERTA CUMPLIDA! Dominancia: ${dominance.toFixed(
                        3
                    )}%`
                );
                const alertSent = await sendTelegramInfo(
                    dominance,
                    totalMarketCap,
                    usdtMarketCapUSD,
                    true
                );
                lastAlertSent = alertSent;
            } else {
                console.log(
                    `📢 Condición de alerta activa, pero no se envía (ya notificado)`
                );
            }
        } else if (shouldAlert && isFirstRun) {
            console.log(
                `🔇 Condición de alerta detectada en primer chequeo - no se envía mensaje`
            );
        } else {
            if (dominance >= DOMINANCE_MAX_THRESHOLD) {
                console.log(
                    `✅ Dominancia por encima del umbral máximo (${DOMINANCE_MAX_THRESHOLD}%)`
                );
            } else if (dominance <= DOMINANCE_MIN_THRESHOLD) {
                console.log(
                    `⬇️ Dominancia por debajo del umbral mínimo (${DOMINANCE_MIN_THRESHOLD}%)`
                );
            }
            lastAlertSent = false;
        }

        lastDominance = dominance;
        return { dominance, totalMarketCap, usdtMarketCapUSD };
    } catch (error) {
        console.error("💥 Error en el chequeo de dominancia:", error.message);

        // Enviar mensaje de error por Telegram si está configurado (excepto en primer chequeo)
        if (
            bot &&
            TELEGRAM_CHAT_ID &&
            SEND_INFO_MESSAGES &&
            !isManual &&
            !isFirstRun
        ) {
            try {
                await bot.sendMessage(
                    TELEGRAM_CHAT_ID,
                    `❌ *Error en el monitor*\n\n📝 ${
                        error.message
                    }\n\n📅 ${new Date().toLocaleString("es-ES", {
                        timeZone: "UTC",
                    })} UTC`,
                    { parse_mode: "Markdown" }
                );
            } catch (telegramError) {
                console.error(
                    "❌ Error adicional al enviar error por Telegram:",
                    telegramError.message
                );
            }
        }

        if (isManual) {
            throw error;
        }
    }
}

// Reiniciar el intervalo de monitoreo
function restartMonitoring() {
    if (monitoringInterval) {
        clearInterval(monitoringInterval);
    }

    const intervalMs = CHECK_INTERVAL_HOURS * 60 * 60 * 1000;
    monitoringInterval = setInterval(() => checkUSDTDominance(), intervalMs);
    console.log(
        `⌚ Intervalo actualizado: cada ${CHECK_INTERVAL_HOURS} hora(s)`
    );
}

// === COMANDOS DEL BOT ===

if (bot) {
    // Comando /start y /help
    bot.onText(/\/start|\/help/, (msg) => {
        const chatId = msg.chat.id;
        const isUserAdmin = isAdmin(msg.from.id);

        const helpMessage = `🤖 *Monitor de Dominancia USDT + Portfolio Tracker*

📊 *Monitoreo USDT:*
/status - Ver dominancia actual
/config - Ver configuración actual

💼 *Gestión de Portfolios:*
/create_wallet <nombre> - Crear nueva wallet
/add_coin <wallet> <moneda> <cantidad> [precio] - Añadir moneda
/sell_coin <wallet> <moneda> <cantidad> <precio> - Registrar venta
/wallet <nombre> - Ver wallet específica
/wallets - Ver todas tus wallets
/leaderboard - Ranking de traders

${
    isUserAdmin
        ? `🔧 *Comandos de administrador:*

/set_interval <horas> - Cambiar intervalo
/set_threshold <min> <max> - Cambiar umbrales
/toggle_messages - Activar/desactivar mensajes
/reload_config - Recargar configuración

*Ejemplos admin:*
\`/set_interval 2\` - Chequear cada 2 horas
\`/set_threshold 3.5 4.0\` - Alertar entre 3.5% y 4.0%`
        : ""
}

🎯 *Rango USDT:* ${DOMINANCE_MIN_THRESHOLD}% - ${DOMINANCE_MAX_THRESHOLD}%`;

        bot.sendMessage(chatId, helpMessage, { parse_mode: "Markdown" });
    });

    // Comando /status - Consulta manual
    bot.onText(/\/status/, async (msg) => {
        const chatId = msg.chat.id;

        try {
            await bot.sendMessage(chatId, "🔍 Consultando datos actuales...");
            await checkUSDTDominance(true, chatId);
        } catch (error) {
            bot.sendMessage(
                chatId,
                `❌ Error al obtener datos: ${error.message}`
            );
        }
    });

    // Comando /config - Ver configuración
    bot.onText(/\/config/, (msg) => {
        const chatId = msg.chat.id;

        const configMessage = `⚙️ *Configuración actual:*

🎯 *Umbrales:* ${DOMINANCE_MIN_THRESHOLD}% - ${DOMINANCE_MAX_THRESHOLD}%
⏰ *Intervalo:* ${CHECK_INTERVAL_HOURS} hora(s)
📨 *Mensajes informativos:* ${
            SEND_INFO_MESSAGES ? "Activados ✅" : "Desactivados ❌"
        }
👑 *Eres admin:* ${isAdmin(msg.from.id) ? "Sí ✅" : "No ❌"}

📅 ${new Date().toLocaleString("es-ES", { timeZone: "UTC" })} UTC`;

        bot.sendMessage(chatId, configMessage, { parse_mode: "Markdown" });
    });

    // === COMANDOS DE PORTFOLIO ===
    bot.onText(/\/create_wallet (.+)/, handleCreateWallet);
    bot.onText(/\/add_coin (\S+) (\S+) ([\d.]+)(?: ([\d.]+))?/, handleAddCoin);
    bot.onText(/\/sell_coin (\S+) (\S+) ([\d.]+) ([\d.]+)/, handleSellCoin);
    bot.onText(/\/wallet (.+)/, handleViewWallet);
    bot.onText(/\/wallets/, handleViewWallets);
    bot.onText(/\/leaderboard/, handleLeaderboard);

    // === COMANDOS DE ADMINISTRACIÓN ===

    // Comando /set_interval - Cambiar intervalo (solo admins)
    bot.onText(/\/set_interval (\d+)/, (msg, match) => {
        const chatId = msg.chat.id;
        const userId = msg.from.id;

        if (!isAdmin(userId)) {
            bot.sendMessage(
                chatId,
                "❌ Solo los administradores pueden cambiar la configuración"
            );
            return;
        }

        const newInterval = parseInt(match[1]);
        if (newInterval < 1 || newInterval > 24) {
            bot.sendMessage(
                chatId,
                "❌ El intervalo debe estar entre 1 y 24 horas"
            );
            return;
        }

        CHECK_INTERVAL_HOURS = newInterval;
        saveConfig();
        restartMonitoring();

        bot.sendMessage(
            chatId,
            `✅ Intervalo cambiado a ${newInterval} hora(s)`
        );
    });

    // Comando /set_threshold - Cambiar umbrales (solo admins)
    bot.onText(/\/set_threshold (\d+\.?\d*) (\d+\.?\d*)/, (msg, match) => {
        const chatId = msg.chat.id;
        const userId = msg.from.id;

        if (!isAdmin(userId)) {
            bot.sendMessage(
                chatId,
                "❌ Solo los administradores pueden cambiar la configuración"
            );
            return;
        }

        const newMin = parseFloat(match[1]);
        const newMax = parseFloat(match[2]);

        if (newMin >= newMax) {
            bot.sendMessage(
                chatId,
                "❌ El umbral mínimo debe ser menor que el máximo"
            );
            return;
        }

        if (newMin < 0 || newMax > 100) {
            bot.sendMessage(
                chatId,
                "❌ Los umbrales deben estar entre 0 y 100"
            );
            return;
        }

        DOMINANCE_MIN_THRESHOLD = newMin;
        DOMINANCE_MAX_THRESHOLD = newMax;
        saveConfig();

        bot.sendMessage(
            chatId,
            `✅ Umbrales cambiados a ${newMin}% - ${newMax}%`
        );
    });

    // Comando /toggle_messages - Activar/desactivar mensajes (solo admins)
    bot.onText(/\/toggle_messages/, (msg) => {
        const chatId = msg.chat.id;
        const userId = msg.from.id;

        if (!isAdmin(userId)) {
            bot.sendMessage(
                chatId,
                "❌ Solo los administradores pueden cambiar la configuración"
            );
            return;
        }

        SEND_INFO_MESSAGES = !SEND_INFO_MESSAGES;
        saveConfig();

        bot.sendMessage(
            chatId,
            `✅ Mensajes informativos ${
                SEND_INFO_MESSAGES ? "activados" : "desactivados"
            }`
        );
    });

    // Comando /reload_config - Recargar configuración (solo admins)
    bot.onText(/\/reload_config/, (msg) => {
        const chatId = msg.chat.id;
        const userId = msg.from.id;

        if (!isAdmin(userId)) {
            bot.sendMessage(
                chatId,
                "❌ Solo los administradores pueden recargar la configuración"
            );
            return;
        }

        loadConfig();
        restartMonitoring();

        bot.sendMessage(
            chatId,
            "✅ Configuración recargada desde archivo y variables de entorno"
        );
    });

    // Manejo de errores del bot
    bot.on("error", (error) => {
        console.error("❌ Error en el bot de Telegram:", error.message);
    });

    bot.on("polling_error", (error) => {
        console.error("❌ Error de polling:", error.message);
    });
}

function startMonitoring() {
    console.log("🚀 Iniciando monitor de dominancia USDT + Portfolio Tracker");

    // Cargar configuración persistente
    loadConfig();

    console.log(
        `⏰ Intervalo de chequeo: cada ${CHECK_INTERVAL_HOURS} hora(s)`
    );
    console.log(
        `📊 Umbral de alerta: ${DOMINANCE_MIN_THRESHOLD}% < dominancia < ${DOMINANCE_MAX_THRESHOLD}%`
    );
    console.log(
        `🤖 Bot Telegram: ${
            TELEGRAM_BOT_TOKEN ? "Configurado ✅" : "No configurado ❌"
        }`
    );
    console.log(
        `💬 Chat ID: ${
            TELEGRAM_CHAT_ID ? "Configurado ✅" : "No configurado ❌"
        }`
    );
    console.log(
        `📨 Mensajes informativos: ${
            SEND_INFO_MESSAGES ? "Activados ✅" : "Desactivados ❌"
        }`
    );
    console.log(
        `👑 Administradores: ${
            ADMIN_IDS.length > 0 ? ADMIN_IDS.join(", ") : "Cualquier usuario"
        }`
    );

    // Ejecutar inmediatamente
    checkUSDTDominance();

    // Programar ejecuciones
    restartMonitoring();

    console.log(`\n⌚ Próximo chequeo en ${CHECK_INTERVAL_HOURS} hora(s)`);
    if (bot) {
        console.log(
            "🤖 Bot de comandos activado - Portfolio Tracker incluido!"
        );
        console.log(
            "💼 Usa /create_wallet para empezar a trackear tu portfolio"
        );
    }
}

// Manejo de errores no capturados
process.on("uncaughtException", (error) => {
    console.error("💥 Error no capturado:", error);
    process.exit(1);
});

process.on("unhandledRejection", (reason, promise) => {
    console.error("💥 Promesa rechazada no manejada:", reason);
});

// Manejo de señales de terminación
process.on("SIGINT", () => {
    console.log("\n👋 Cerrando monitor de dominancia USDT...");
    if (monitoringInterval) {
        clearInterval(monitoringInterval);
    }
    if (bot) {
        bot.stopPolling();
    }
    process.exit(0);
});

process.on("SIGTERM", () => {
    console.log("\n👋 Cerrando monitor de dominancia USDT...");
    if (monitoringInterval) {
        clearInterval(monitoringInterval);
    }
    if (bot) {
        bot.stopPolling();
    }
    process.exit(0);
});

// Iniciar la aplicación
if (require.main === module) {
    startMonitoring();
}

module.exports = {
    checkUSDTDominance,
    calculateUSDTDominance,
    getGlobalMarketData,
};
