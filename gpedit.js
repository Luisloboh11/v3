const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    downloadContentFromMessage,
    makeCacheableSignalKeyStore
} = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const pino = require('pino');
const readline = require('readline');
const { exec } = require('child_process');
const fs = require('fs');
const os = require('os'); // <--- ADICIONADO

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const question = (text) => new Promise((resolve) => rl.question(text, resolve));

// ==================== CONFIGURAÇÕES ====================
let antiDeleteAtivo = true;
let gruposIgnorados = new Set();
const messageLog = new Map();
const CACHE_DURATION = 120000;
const jidCache = new Map();

// ==================== CORES ANSI ====================
const cor = {
    reset: '\x1b[0m',
    negrito: '\x1b[1m',
    vermelho: '\x1b[31m',
    verde: '\x1b[32m',
    amarelo: '\x1b[33m',
    azul: '\x1b[34m',
    magenta: '\x1b[35m',
    ciano: '\x1b[36m',
    cinza: '\x1b[90m',
    branco: '\x1b[37m'
};

// ==================== EMOJIS ====================
const emoji = {
    sucesso: '✅',
    erro: '❌',
    aviso: '⚠️',
    bot: '🤖',
    imagem: '📸',
    video: '🎥',
    audio: '🎵',
    sticker: '🎨',
    antidelete: '🛡️',
    ping: '⚡',
    menu: '📋',
    ban: '🔨',
    aberto: '🔓',
    fechado: '🔒'
};

// ==================== FUNÇÕES DE LOG ====================
function log(message, tipo = 'info') {
    const cores = {
        sucesso: cor.verde,
        erro: cor.vermelho,
        aviso: cor.amarelo,
        info: cor.ciano,
        bot: cor.azul
    };
    
    const emojis = {
        sucesso: emoji.sucesso,
        erro: emoji.erro,
        aviso: emoji.aviso,
        info: '📢',
        bot: emoji.bot
    };
    
    const corEscolhida = cores[tipo] || cor.branco;
    const emojiEscolhido = emojis[tipo] || '';
    
    console.log(`${cor.cinza}[${new Date().toLocaleTimeString()}]${cor.reset} ${corEscolhida}${emojiEscolhido} ${message}${cor.reset}`);
}

// ==================== BANNER ====================
function mostrarBanner() {
    console.clear();
    console.log(`${cor.ciano}${cor.negrito}`);
    console.log('╔════════════════════════════╗');
    console.log('║       BOT ELITE v2.0       ║');
    console.log('║    🔓 MODO PÚBLICO 🔓      ║');
    console.log('║    🛡️ ANTI-DELETE ATIVO   ║');
    console.log('╚════════════════════════════╝');
    console.log(`${cor.reset}`);
    log('Inicializando...', 'bot');
    console.log('');
}

// ==================== FUNÇÕES UTILITÁRIAS ====================
function normalizeNumber(value) {
    return String(value || '').replace(/\D/g, '');
}

function normalizeAnyJid(jidLike) {
    if (!jidLike) return '';
    
    const cacheKey = String(jidLike);
    if (jidCache.has(cacheKey)) return jidCache.get(cacheKey);
    
    const raw = String(jidLike);
    const user = raw.split('@')[0].split(':')[0];
    const result = user ? `${user}@s.whatsapp.net` : '';
    
    if (jidCache.size > 100) {
        const firstKey = jidCache.keys().next().value;
        jidCache.delete(firstKey);
    }
    jidCache.set(cacheKey, result);
    
    return result;
}

function toJid(number) {
    const clean = normalizeNumber(number);
    return clean ? `${clean}@s.whatsapp.net` : '';
}

function getMessageText(message) {
    if (!message) return '';
    if (message.conversation) return message.conversation;
    if (message.extendedTextMessage?.text) return message.extendedTextMessage.text;
    if (message.imageMessage?.caption) return message.imageMessage.caption;
    if (message.videoMessage?.caption) return message.videoMessage.caption;
    return '';
}

function getQuotedMessage(message) {
    return (
        message?.extendedTextMessage?.contextInfo?.quotedMessage ||
        message?.imageMessage?.contextInfo?.quotedMessage ||
        message?.videoMessage?.contextInfo?.quotedMessage ||
        null
    );
}

// ==================== FUNÇÃO PARA OBTER TIPO DE MÍDIA ====================
function getMediaType(message) {
    if (!message) return null;
    
    if (message.imageMessage) return { type: 'image', data: message.imageMessage };
    if (message.videoMessage) return { type: 'video', data: message.videoMessage };
    if (message.audioMessage) return { type: 'audio', data: message.audioMessage };
    if (message.documentMessage) return { type: 'document', data: message.documentMessage };
    if (message.stickerMessage) return { type: 'sticker', data: message.stickerMessage };
    
    return null;
}

// ==================== FUNÇÃO PARA BAIXAR MÍDIA ====================
async function downloadMedia(message, mediaType) {
    try {
        const stream = await downloadContentFromMessage(message, mediaType);
        let buffer = Buffer.from([]);
        for await (const chunk of stream) {
            buffer = Buffer.concat([buffer, chunk]);
        }
        return buffer;
    } catch (error) {
        log(`Erro ao baixar mídia: ${error.message}`, 'erro');
        return null;
    }
}

// ==================== VERIFICAR SE É ADMIN DO GRUPO ====================
async function isGroupAdmin(sock, groupJid, userJid) {
    try {
        const groupMetadata = await sock.groupMetadata(groupJid);
        const participant = groupMetadata.participants.find(p => p.id === userJid);
        return participant && (participant.admin === 'admin' || participant.admin === 'superadmin');
    } catch (error) {
        return false;
    }
}

async function isBotAdmin(sock, groupJid) {
    try {
        const groupMetadata = await sock.groupMetadata(groupJid);
        const botId = sock.user.id.split(':')[0] + '@s.whatsapp.net';
        const participant = groupMetadata.participants.find(p => p.id === botId);
        return participant && (participant.admin === 'admin' || participant.admin === 'superadmin');
    } catch (error) {
        return false;
    }
}

// ==================== GERENCIAR GRUPOS IGNORADOS ====================
function carregarGruposIgnorados() {
    try {
        if (fs.existsSync('grupos_ignorados.json')) {
            const dados = fs.readFileSync('grupos_ignorados.json', 'utf8');
            const parsed = JSON.parse(dados);
            gruposIgnorados = new Set(parsed);
        } else {
            fs.writeFileSync('grupos_ignorados.json', '[]');
        }
    } catch (error) {
        gruposIgnorados = new Set();
    }
}

function salvarGruposIgnorados() {
    try {
        fs.writeFileSync('grupos_ignorados.json', JSON.stringify([...gruposIgnorados], null, 2));
    } catch (error) {}
}

function isGrupoIgnorado(jid) {
    if (!jid) return false;
    return gruposIgnorados.has(jid);
}

// ==================== FUNÇÃO PRINCIPAL ====================
async function connectToWhatsApp() {
    mostrarBanner();
    carregarGruposIgnorados();
    
    log('Carregando autenticação...', 'info');
    
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    const { version } = await fetchLatestBaileysVersion();
    let adminJid = normalizeAnyJid(state.creds?.me?.id);

    log('Autenticação carregada!', 'sucesso');
    log('Conectando ao WhatsApp...', 'info');

    const sock = makeWASocket({
        version,
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' })),
        },
        printQRInTerminal: false,
        logger: pino({ level: 'silent' }),
        browser: ['Ubuntu', 'Chrome', '20.0.04'],
        generateHighQualityLinkPreview: false
    });

    if (!sock.authState.creds.registered) {
        console.log('\n');
        log('Nenhuma sessão encontrada!', 'aviso');
        log('Iniciando processo de pareamento...\n', 'info');
        
        const phoneNumber = normalizeNumber(await question(`${cor.ciano}📱 Digite seu número (ex: 5511999999999): ${cor.reset}`));
        adminJid = toJid(phoneNumber);

        log('Solicitando código de pareamento...', 'info');
        
        setTimeout(async () => {
            try {
                const code = await sock.requestPairingCode(phoneNumber);
                log('Código gerado!', 'sucesso');
                console.log('\n');
                
                console.log(`${cor.amarelo}${cor.negrito}════════════════════════════════${cor.reset}`);
                console.log(`${cor.amarelo}${cor.negrito}   CÓDIGO: ${code.match(/.{1,4}/g).join('-')}${cor.reset}`);
                console.log(`${cor.amarelo}${cor.negrito}════════════════════════════════${cor.reset}`);
                
                console.log(`\n${cor.ciano}📝 Instruções:${cor.reset}`);
                console.log('1. Abra o WhatsApp no seu celular');
                console.log('2. Vá em Aparelhos Conectados');
                console.log('3. Toque em "Conectar com número de telefone"');
                console.log('4. Digite o código acima\n');
            } catch (err) {
                log(`Erro ao gerar código: ${err.message}`, 'erro');
            }
        }, 3000);
    }

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update;

        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect.error instanceof Boom)?.output?.statusCode !== DisconnectReason.loggedOut;
            
            console.log('\n');
            log('Conexão fechada!', 'erro');
            log(`Motivo: ${lastDisconnect.error?.message || 'desconhecido'}`, 'info');
            
            if (shouldReconnect) {
                log('Tentando reconectar em 5 segundos...', 'aviso');
                setTimeout(() => connectToWhatsApp(), 5000);
            } else {
                log('Você foi desconectado permanentemente!', 'erro');
                log('Apague a pasta "auth_info_baileys" e tente novamente.', 'info');
                process.exit();
            }
        } else if (connection === 'open') {
            log('CONECTADO COM SUCESSO!', 'sucesso');
            adminJid = adminJid || normalizeAnyJid(sock.authState.creds?.me?.id);
            
            console.log('\n');
            console.log(`${cor.verde}${cor.negrito}════════════════════════════════${cor.reset}`);
            console.log(`${cor.verde}${cor.negrito}   ✅ BOT ONLINE${cor.reset}`);
            console.log(`${cor.verde}${cor.negrito}════════════════════════════════${cor.reset}`);
            console.log(`${cor.verde}👑 Admin: ${cor.reset}${adminJid?.split('@')[0] || 'Aguardando'}`);
            console.log(`${cor.verde}⏰ Hora: ${cor.reset}${new Date().toLocaleString()}`);
            console.log(`${cor.verde}💾 RAM: ${cor.reset}${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB`);
            console.log(`${cor.verde}════════════════════════════════${cor.reset}\n`);
        }
    });

    sock.ev.on('messages.upsert', async (m) => {
        const msg = m.messages?.[0];
        
        if (!msg || !msg.message) return;
        
        const msgId = msg.key.id;
        const from = msg.key.remoteJid;
        const participant = msg.key.participant;
        const isGroup = from?.endsWith('@g.us');
        
        let senderName = msg.key.fromMe ? 'EU' : (participant?.split('@')[0] || from?.split('@')[0]);
        const senderJid = msg.key.participant || msg.key.remoteJid;
        
        // Mostrar mensagem no terminal
        const msgText = getMessageText(msg.message);
        if (msgText && !msg.key.fromMe) {
            console.log(`${cor.cinza}[${new Date().toLocaleTimeString()}]${cor.reset} ${cor.amarelo}📨 ${senderName}: ${cor.reset}${msgText.substring(0, 50)}`);
        }
        
        // ==================== ANTI-DELETE CORRIGIDO - SUPORTA MÍDIAS ====================
        const isProtocol = msg.message?.protocolMessage?.type === 0;
        
        if (isProtocol && antiDeleteAtivo && !isGrupoIgnorado(from)) {
            const deletedKeyId = msg.message.protocolMessage.key.id;
            const deletedMsg = messageLog.get(deletedKeyId);
            
            if (deletedMsg && !deletedMsg.key.fromMe) {
                const ondeFoiApagado = deletedMsg.key.remoteJid;
                const autor = deletedMsg.key.participant || deletedMsg.key.remoteJid;
                const autorNome = autor?.split('@')[0];
                const mensagemOriginal = deletedMsg.message;
                
                try {
                    // Verifica se é uma mensagem de texto
                    const texto = getMessageText(mensagemOriginal);
                    
                    if (texto) {
                        // Se for texto, envia como texto
                        await sock.sendMessage(ondeFoiApagado, { 
                            text: `🛡️ @${autorNome} apagou:\n${texto}`,
                            mentions: [autor]
                        });
                    } else {
                        // Se for mídia, baixa e reenvia
                        const media = getMediaType(mensagemOriginal);
                        
                        if (media) {
                            const buffer = await downloadMedia(media.data, media.type);
                            
                            if (buffer) {
                                const caption = `🛡️ @${autorNome} apagou esta ${media.type}`;
                                
                                if (media.type === 'image') {
                                    await sock.sendMessage(ondeFoiApagado, { 
                                        image: buffer, 
                                        caption: caption,
                                        mentions: [autor]
                                    });
                                } else if (media.type === 'video') {
                                    await sock.sendMessage(ondeFoiApagado, { 
                                        video: buffer, 
                                        caption: caption,
                                        mentions: [autor]
                                    });
                                } else if (media.type === 'audio') {
                                    await sock.sendMessage(ondeFoiApagado, { 
                                        audio: buffer, 
                                        mimetype: 'audio/mpeg',
                                        ptt: true,
                                        mentions: [autor]
                                    });
                                } else if (media.type === 'sticker') {
                                    await sock.sendMessage(ondeFoiApagado, { 
                                        sticker: buffer,
                                        mentions: [autor]
                                    });
                                } else {
                                    await sock.sendMessage(ondeFoiApagado, { 
                                        document: buffer,
                                        caption: `🛡️ @${autorNome} apagou este arquivo`,
                                        mentions: [autor]
                                    });
                                }
                                
                                log(`✅ Mídia recuperada de @${autorNome}`, 'sucesso');
                            } else {
                                await sock.sendMessage(ondeFoiApagado, { 
                                    text: `🛡️ @${autorNome} apagou uma ${media.type} (não foi possível recuperar)`,
                                    mentions: [autor]
                                });
                            }
                        } else {
                            await sock.sendMessage(ondeFoiApagado, { 
                                text: `🛡️ @${autorNome} apagou uma mensagem (tipo não suportado)`,
                                mentions: [autor]
                            });
                        }
                    }
                } catch (e) {
                    log(`Erro ao recuperar: ${e.message}`, 'erro');
                }
            }
            return;
        }
        
        // ==================== SALVAR MENSAGENS ====================
        if (msg.message && !msg.key.fromMe) {
            messageLog.set(msgId, msg);
            setTimeout(() => {
                messageLog.delete(msgId);
            }, CACHE_DURATION);
        }
        
        // ==================== COMANDOS ====================
        const text = getMessageText(msg.message).trim();
        if (!text) return;
        
        const command = text.split(' ')[0].toLowerCase();
        const args = text.split(' ').slice(1);
        const replyTo = from;
        
        // ==================== MENU ====================
        if (command === '.menu') {
            const menuTexto = `🤖 *BOT ELITE*

📸 .ver + mídia - Baixar
🎨 .s - Sticker
⚡ .ping - Latência

👑 *Admin do grupo*
🔨 .ban @membro
➕ .add 5511999999999
🔒 .fechar / .abrir
🛡️ .antidel on/off - Anti-Delete

🛡️ *Anti-Delete captura:*
📝 Textos
📸 Fotos
🎥 Vídeos
🎵 Áudios`;

            await sock.sendMessage(replyTo, { text: menuTexto });
            return;
        }
        
        // ==================== PING ====================
        if (command === '.ping') {
            const start = Date.now();
            const latency = Date.now() - start;
            await sock.sendMessage(replyTo, { text: `⚡ ${latency}ms` });
            return;
        }
        
        // ==================== ANTI-DELETE ====================
        if (command === '.antidel' && isGroup) {
            const isAdminUser = await isGroupAdmin(sock, from, senderJid);
            if (!isAdminUser) {
                await sock.sendMessage(replyTo, { text: `❌ Apenas admin do grupo` });
                return;
            }
            
            const subcomando = args[0]?.toLowerCase();
            
            if (subcomando === 'on') {
                if (gruposIgnorados.has(from)) {
                    gruposIgnorados.delete(from);
                    salvarGruposIgnorados();
                    await sock.sendMessage(replyTo, { text: `🛡️ Anti-Delete ATIVADO` });
                } else {
                    await sock.sendMessage(replyTo, { text: `✅ Já está ativo` });
                }
            } 
            else if (subcomando === 'off') {
                if (!gruposIgnorados.has(from)) {
                    gruposIgnorados.add(from);
                    salvarGruposIgnorados();
                    await sock.sendMessage(replyTo, { text: `🚫 Anti-Delete DESATIVADO` });
                } else {
                    await sock.sendMessage(replyTo, { text: `⚠️ Já está desativado` });
                }
            }
            else {
                const status = gruposIgnorados.has(from) ? 'DESATIVADO' : 'ATIVO';
                await sock.sendMessage(replyTo, { text: `🛡️ Anti-Delete: ${status}\n.antidel on - Ativar\n.antidel off - Desativar` });
            }
            return;
        }
        
        // ==================== BAN ====================
        if (command === '.ban' && isGroup) {
            const isAdminUser = await isGroupAdmin(sock, from, senderJid);
            if (!isAdminUser) {
                await sock.sendMessage(replyTo, { text: `❌ Apenas admin` });
                return;
            }
            
            const isBotAdminUser = await isBotAdmin(sock, from);
            if (!isBotAdminUser) {
                await sock.sendMessage(replyTo, { text: `❌ Bot precisa ser admin` });
                return;
            }
            
            const mentioned = msg.message.extendedTextMessage?.contextInfo?.mentionedJid;
            if (!mentioned || mentioned.length === 0) {
                await sock.sendMessage(replyTo, { text: `❌ Marque alguém\n.ban @membro` });
                return;
            }
            
            const target = mentioned[0];
            
            try {
                await sock.groupParticipantsUpdate(from, [target], 'remove');
                await sock.sendMessage(replyTo, { text: `🔨 @${target.split('@')[0]} expulso`, mentions: [target] });
            } catch (error) {
                await sock.sendMessage(replyTo, { text: `❌ ${error.message}` });
            }
            return;
        }
        
        // ==================== ADD ====================
        if (command === '.add' && isGroup) {
            const isAdminUser = await isGroupAdmin(sock, from, senderJid);
            if (!isAdminUser) {
                await sock.sendMessage(replyTo, { text: `❌ Apenas admin` });
                return;
            }
            
            const isBotAdminUser = await isBotAdmin(sock, from);
            if (!isBotAdminUser) {
                await sock.sendMessage(replyTo, { text: `❌ Bot precisa ser admin` });
                return;
            }
            
            const numero = args[0];
            if (!numero) {
                await sock.sendMessage(replyTo, { text: `❌ Ex: .add 5511999999999` });
                return;
            }
            
            const numeroLimpo = normalizeNumber(numero);
            const numeroJid = `${numeroLimpo}@s.whatsapp.net`;
            
            try {
                await sock.groupParticipantsUpdate(from, [numeroJid], 'add');
                await sock.sendMessage(replyTo, { text: `✅ @${numeroLimpo} adicionado`, mentions: [numeroJid] });
            } catch (error) {
                let msgErro = `❌ ${error.message}`;
                if (error.message.includes('409')) {
                    msgErro = `❌ Aguarde alguns minutos antes de adicionar novamente`;
                }
                await sock.sendMessage(replyTo, { text: msgErro });
            }
            return;
        }
        
        // ==================== FECHAR GRUPO ====================
        if (command === '.fechar' && isGroup) {
            const isAdminUser = await isGroupAdmin(sock, from, senderJid);
            if (!isAdminUser) {
                await sock.sendMessage(replyTo, { text: `❌ Apenas admin` });
                return;
            }
            
            try {
                await sock.groupSettingUpdate(from, 'announcement');
                await sock.sendMessage(replyTo, { text: `🔒 Grupo fechado` });
            } catch (error) {
                await sock.sendMessage(replyTo, { text: `❌ ${error.message}` });
            }
            return;
        }
        
        // ==================== ABRIR GRUPO ====================
        if (command === '.abrir' && isGroup) {
            const isAdminUser = await isGroupAdmin(sock, from, senderJid);
            if (!isAdminUser) {
                await sock.sendMessage(replyTo, { text: `❌ Apenas admin` });
                return;
            }
            
            try {
                await sock.groupSettingUpdate(from, 'not_announcement');
                await sock.sendMessage(replyTo, { text: `🔓 Grupo aberto` });
            } catch (error) {
                await sock.sendMessage(replyTo, { text: `❌ ${error.message}` });
            }
            return;
        }
        
        // ==================== STICKER ====================
        if (command === '.s' || command === '.sticker') {
            try {
                let imageMessage = msg.message.imageMessage || 
                                  msg.message.extendedTextMessage?.contextInfo?.quotedMessage?.imageMessage;
                
                if (!imageMessage) {
                    await sock.sendMessage(replyTo, { text: `❌ Marque uma foto` });
                    return;
                }

                const stream = await downloadContentFromMessage(imageMessage, 'image');
                let buffer = Buffer.from([]);
                for await(const chunk of stream) {
                    buffer = Buffer.concat([buffer, chunk]);
                }
                
                // ===== CORREÇÃO PARA WINDOWS =====
                const tempDir = os.tmpdir();
                const inputPath = `${tempDir}\\temp_${Date.now()}.jpg`;
                const outputPath = `${tempDir}\\temp_${Date.now()}.webp`;
                // ==================================
                
                fs.writeFileSync(inputPath, buffer);
                
                exec(`ffmpeg -i "${inputPath}" -vf "scale=512:512:force_original_aspect_ratio=increase,crop=512:512" -vcodec libwebp -lossless 0 -qscale 80 -loop 0 -an "${outputPath}"`, async (error) => {
                    // Remoção segura
                    try { fs.unlinkSync(inputPath); } catch (_) {}
                    
                    if (error) {
                        await sock.sendMessage(replyTo, { text: `❌ Erro` });
                        return;
                    }
                    
                    try {
                        const stickerBuffer = fs.readFileSync(outputPath);
                        await sock.sendMessage(replyTo, { sticker: stickerBuffer });
                        try { fs.unlinkSync(outputPath); } catch (_) {}
                    } catch (err) {
                        await sock.sendMessage(replyTo, { text: `❌ Erro` });
                    }
                });
                
            } catch (e) {
                await sock.sendMessage(replyTo, { text: `❌ Erro` });
            }
            return;
        }
        
        // ==================== DOWNLOAD COM .ver ====================
        if (command === '.ver') {
            const quotedMsg = getQuotedMessage(msg.message);

            if (!quotedMsg) {
                await sock.sendMessage(replyTo, { text: `❌ Marque a mídia` });
                return;
            }

            try {
                let viewOnceMsg = quotedMsg.viewOnceMessageV2?.message || quotedMsg.viewOnceMessage?.message || quotedMsg;
                let mediaType = Object.keys(viewOnceMsg || {})[0];

                if (!mediaType) {
                    await sock.sendMessage(replyTo, { text: `❌ Mídia não encontrada` });
                    return;
                }

                if (mediaType === 'messageContextInfo') {
                    mediaType = Object.keys(viewOnceMsg || {})[1];
                }

                let mediaContent = viewOnceMsg?.[mediaType];
                let streamType;

                if (mediaType === 'imageMessage') streamType = 'image';
                else if (mediaType === 'videoMessage') streamType = 'video';
                else if (mediaType === 'audioMessage') streamType = 'audio';
                else {
                    if (quotedMsg.imageMessage) {
                        streamType = 'image';
                        mediaContent = quotedMsg.imageMessage;
                    } else if (quotedMsg.videoMessage) {
                        streamType = 'video';
                        mediaContent = quotedMsg.videoMessage;
                    } else if (quotedMsg.audioMessage) {
                        streamType = 'audio';
                        mediaContent = quotedMsg.audioMessage;
                    } else {
                        await sock.sendMessage(replyTo, { text: `❌ Tipo não suportado` });
                        return;
                    }
                }

                const stream = await downloadContentFromMessage(mediaContent, streamType);
                let buffer = Buffer.from([]);
                for await (const chunk of stream) {
                    buffer = Buffer.concat([buffer, chunk]);
                }

                if (streamType === 'image') {
                    await sock.sendMessage(replyTo, { image: buffer, caption: `📸` });
                } else if (streamType === 'video') {
                    await sock.sendMessage(replyTo, { video: buffer, caption: `🎥` });
                } else if (streamType === 'audio') {
                    await sock.sendMessage(replyTo, { audio: buffer, mimetype: 'audio/mpeg', ptt: true });
                }
                
            } catch (err) {
                await sock.sendMessage(replyTo, { text: `❌ Erro` });
            }
        }
    });
}

// ==================== INICIALIZAÇÃO ====================
connectToWhatsApp().catch((err) => {
    console.log('\n');
    log('Erro fatal: ' + err.message, 'erro');
    process.exit(1);
});

process.on('SIGINT', () => {
    console.log('\n\n');
    log('Bot desligado', 'aviso');
    process.exit();
});