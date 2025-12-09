// Importando as libs
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const { GoogleGenAI } = require('@google/genai');
const { createClient } = require("@supabase/supabase-js");
const qrcode = require('qrcode-terminal');
const path = require('path');
const fs = require('fs');

require('dotenv').config();

// Apis key
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
// const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SUPABASE_BUCKET = process.env.SUPABASE_BUCKET;

// Configuracao dos logs
const LOG_FILE = path.join(__dirname, `logs-${new Date().toISOString().split('T')[0]}.log`);
const grupoLogs = '120363419242712121@g.us';

const prompt = fs.readFileSync('prompt2.txt', 'utf-8');
const contatos = fs.readFileSync('contatos.txt', 'utf-8')
    .split('\n')
    .map(c => c.trim())
    .filter(Boolean);

console.log("Iniciando o bot...");

// Clients
const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: { args: ['--no-sandbox'] }
});
const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// Remove ```json ou ```lang e os backticks finais
function limparJson(text) {
    return text.replace(/```(?:[a-zA-Z]+\n)?([\s\S]*?)```/, '$1').trim();
}

// Funcao para fazer logs diarios locais, console e tambem log via whatsapp    
function log(message, level = "INFO") {
    const timestamp = new Date().toISOString();
    const logMessage = `[${timestamp}] [${level}] ${message}`;


    switch (level.toLowerCase()) {
        case 'info': console.log(logMessage); break;
        case 'warn': console.warn(logMessage); break;
        case 'error': console.error(logMessage); break;
        case 'debug': console.debug(logMessage); break;
    }
    fs.appendFileSync(LOG_FILE, logMessage + '\n');

    // Envia para o grupo de log (se o client já estiver pronto e grupo definido)
    if (client && grupoLogs) {
        let prefixo = {
            "INFO": "ℹ",
            "WARN": "⚠️",
            "ERROR": "❌",
            "DEBUG": "🛠️"
        }[level] || "📄";

        client.sendMessage(grupoLogs, `${prefixo} ${logMessage}`).catch(() => { });
    }
}

// Faz o request do Gemini usando o prompt pre-definido e a imagem passada    
async function chamarGemini(imageData) {
    const inicio = Date.now();

    const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: [
            { role: 'user', parts: [{ text: prompt }, imageData] }
        ]
    });

    const fim = Date.now();
    const duracaoMs = fim - inicio;
    log(`⏱️ Tempo de execução da IA: ${duracaoMs}ms`, 'DEBUG');

    return (await response.text);
}

async function salvarEncarteBucket(media, fonteContato) {
    const fileBuffer = Buffer.from(media.data, 'base64');
    const nomeArquivo = `encartes-publico/encarte-${fonteContato.replace(/[^0-9]/g, '')}-${Date.now()}.jpg`;

    log(`Fazendo upload do encarte ${nomeArquivo} para o bucket.`, 'INFO');

    const inicio = Date.now();

    const { data, error } = await supabase
        .storage
        .from(SUPABASE_BUCKET)
        .upload(nomeArquivo, fileBuffer, {
            contentType: media.mimetype,
            upsert: true
        });

    if (error) {
        log(`Erro ao fazer upload do encarte: ${nomeArquivo}: ${JSON.stringify(error)}`, 'ERROR');
        return null;
    }

    const fim = Date.now();
    const duracaoMs = fim - inicio;
    log(`⏱️ Tempo de execução para o upload do encarte: ${duracaoMs}ms`, 'DEBUG');

    log(`Upload bem-sucedido! Caminho do arquivo: ${data.path}`, 'INFO');
    return data.path;
}

async function salvarDadosSupabase(dadosJson, fonteContato, caminhoEncarte) {
    log('Iniciando o salvamento dos dados no banco de dados...', 'INFO');

    const { supermercado, validade_promocao, produtos } = dadosJson;

    const inicioTotal = Date.now();
    const inicioEncarte = Date.now();

    const { data: encarteData, error: encarteError } = await supabase
        .from('encartes')
        .insert({
            supermercado: supermercado,
            validade_promocao: validade_promocao,
            fonte_contato: fonteContato,
            caminho_imagem_bucket: caminhoEncarte
        })
        .select('id');

    if (encarteError) {
        log(`Erro ao salvar encarte: ${encarteError.message}`, 'ERROR');
        return;
    }

    const fimEncarte = Date.now();
    const duracaoEncarteMs = fimEncarte - inicioEncarte;
    log(`⏱️ Tempo de execução para salvar o encarte no banco: ${duracaoEncarteMs}ms`, 'DEBUG');
    const encarteId = encarteData[0].id;
    log(`🗂️ Encarte criado com ID: ${encarteId}`, 'INFO');

    const inicioProdutos = Date.now();
    for (const produto of produtos) {
        const { produto_nome, marca, preco_float, unidade_padronizada, valor_padronizado, preco_por_unidade } = produto;

        // Verifica ou cria produto no catálogo
        const { data: produtoExistente, error: erroBusca } = await supabase
            .from('catalogo_produtos')
            .select('id')
            .eq('produto_nome', produto_nome)
            .eq('marca', marca);

        let produtoId;

        if (erroBusca) {
            log(`Erro ao buscar produto: ${erroBusca.message}`, 'ERROR');
            continue;
        }

        if (produtoExistente.length > 0) {
            produtoId = produtoExistente[0].id;
        } else {
            const { data: novoProduto, error: erroNovo } = await supabase
                .from('catalogo_produtos')
                .insert([{ produto_nome, marca }])
                .select('id');

            if (erroNovo) {
                log(`Erro ao inserir novo produto: ${erroNovo.message}`, 'ERROR');
                continue;
            }

            produtoId = novoProduto[0].id;
            log(`🆕 Produto adicionado ao catálogo com ID ${produtoId}`, 'INFO');
        }

        // Cria promoção
        const { error: erroPromocao } = await supabase
            .from('promocoes')
            .insert([
                {
                    encarte_id: encarteId,
                    produto_id: produtoId,
                    preco_float,
                    unidade_padronizada,
                    valor_padronizado
                }
            ]);

        if (erroPromocao) {
            log(`Erro ao salvar promoção do produto ${produto_nome}: ${erroPromocao.message}`, 'ERROR');
            continue;
        }

        const fimProdutos = Date.now();
        const duracaoProdutosMs = fimProdutos - inicioProdutos;
        log(`⏱️ Tempo de execução para salvar todos os produtos no banco: ${duracaoProdutosMs}ms`, 'DEBUG');
        log(`Promoção salva: ${produto_nome} - R$ ${preco_float}`, 'INFO');
    }

    const fimTotal = Date.now();
    const duracaoTotalMs = fimTotal - inicioTotal;
    log(`⏱️ Tempo de execução para salvar todos os dados no banco: ${duracaoTotalMs}ms`, 'DEBUG');
    log('Todos os dados salvos com sucesso!', 'INFO');
}

client.on('qr', (qr) => {
    console.log('QR Code recebido, escaneie com seu celular:');
    qrcode.generate(qr, { small: true });
});

client.on('ready', () => {
    log('Cliente conectado e pronto!', 'INFO');
});

client.on('message_create', async (message) => {
    if (message.body == "!ping") {
        log(`Ping recebida de: ${message.from} | ${(await message.getContact()).pushname}`, 'INFO');
        await message.reply("Bot: pong!");
        return;
    }

    if (message.body == "!chatid") {
        const chatid = (await message.getChat()).id._serialized;
        log(`ChatId de: ${chatid}`, 'INFO');
        await message.reply(`Bot: ${chatid}`);
        return;
    }

    if (message.body == "!encarteNovo" && message.hasMedia) {
        log(`Imagem recebida de: ${message.from} | ${(await message.getContact()).pushname}`, 'INFO');

        try {
            const media = await message.downloadMedia();

            // Conversao de base64 para objeto válido para a API Gemini
            const imageData = {
                inlineData: {
                    data: media.data,
                    mimeType: media.mimetype
                }
            };

            log(`Mídia baixada com sucesso de ${message.from}`, 'DEBUG');
            log(`Fazendo request para o Gemini de ${message.from}`, 'DEBUG');

            const output = limparJson(await chamarGemini(imageData));

            log(`Resposta do Gemini: ${output}`, 'INFO');

            const caminhoArquivo = await salvarEncarteBucket(media, message.from);

            if (!caminhoArquivo) return;

            try {
                const json = JSON.parse(output);
                await salvarDadosSupabase(json, message.from, caminhoArquivo);
            } catch (error) {
                log(`Erro ao fazer parse do JSON: ${error.message}`, 'ERROR');
            }
        } catch (error) {
            log(`Erro com ${message.from}: ${error.message}`, 'ERROR');
        }
    }
});

client.on('message', async (message) => {
    if (message.hasMedia && message.type === 'image' && contatos.includes(message.from)) {
        log(`Imagem recebida de: ${message.from} | ${(await message.getContact()).pushname}`, 'INFO');

        try {
            const media = await message.downloadMedia();

            // Conversao de base64 para objeto válido para a API Gemini
            const imageData = {
                inlineData: {
                    data: media.data,
                    mimeType: media.mimetype
                }
            };

            log(`Mídia baixada com sucesso de ${message.from}`, 'DEBUG');
            log(`Fazendo request para o Gemini de ${message.from}`, 'DEBUG');

            const output = limparJson(await chamarGemini(imageData));

            log(`Resposta do Gemini: ${output}`, 'INFO');

            const caminhoArquivo = await salvarEncarteBucket(media, message.from);

            if (!caminhoArquivo) return;

            try {
                const json = JSON.parse(output);
                await salvarDadosSupabase(json, message.from, caminhoArquivo);
            } catch (error) {
                log(`Erro ao fazer parse do JSON: ${error.message}`, 'ERROR');
            }
        } catch (error) {
            log(`Erro com ${message.from}: ${error.message}`, 'ERROR');
        }
    }
});

client.initialize();
