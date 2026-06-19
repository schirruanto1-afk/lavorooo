require('dotenv').config();

const express = require('express');
const cors = require('cors');
const { google } = require('googleapis');
const Groq = require('groq-sdk');

const app = express();
app.use(cors());
app.use(express.json());

// ===== Credenziali Google =====
const CLIENT_ID     = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const REFRESH_TOKEN = process.env.GOOGLE_REFRESH_TOKEN;

const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET);
oauth2Client.setCredentials({ refresh_token: REFRESH_TOKEN });

const drive = google.drive({ version: 'v3', auth: oauth2Client });
const docs  = google.docs({  version: 'v1', auth: oauth2Client });

// ===== Client Groq (gratuito) =====
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// ===== LOG DIAGNOSTICO =====
function maschera(v) {
  if (!v) return 'MANCANTE (undefined/vuoto)';
  return `lunghezza=${v.length}, inizio="${v.slice(0, 6)}...", fine="...${v.slice(-6)}"`;
}
console.log('--- DIAGNOSTICA CREDENZIALI ---');
console.log('GOOGLE_CLIENT_ID:', maschera(CLIENT_ID));
console.log('GOOGLE_CLIENT_SECRET:', maschera(CLIENT_SECRET));
console.log('GOOGLE_REFRESH_TOKEN:', maschera(REFRESH_TOKEN));
console.log('GROQ_API_KEY:', maschera(process.env.GROQ_API_KEY));
console.log('-------------------------------');

// ===== Endpoint principale =====
app.post('/api/genera', async (req, res) => {
  try {
    const { paziente, richiesta } = req.body;

    if (!paziente || !paziente.nome || !paziente.cognome) {
      return res.status(400).json({ success: false, error: 'Dati paziente mancanti (nome/cognome).' });
    }

    const richiestaFinale = richiesta?.trim() ||
      'Genera una cartella clinica completa con sezioni per anamnesi, diagnosi, obiettivi terapeutici e note di seduta';

    console.log(`--> Richiesta per ${paziente.nome} ${paziente.cognome}: "${richiestaFinale}"`);

    // 1. Genera il contenuto con Groq (Llama 3 - gratuito)
    const completion = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      messages: [
        {
          role: 'system',
          content: `Sei un assistente che aiuta uno psicoterapeuta a redigere documenti clinici professionali in italiano.
Scrivi in modo chiaro, professionale e clinicamente appropriato.
Non inventare informazioni cliniche specifiche non fornite: se mancano dati, lascia segnaposto tra parentesi quadre (es. [da completare]).
Restituisci SOLO il testo del documento, senza markdown, senza intestazioni tipo "Ecco il documento", pronto per essere inserito in un Google Doc.`
        },
        {
          role: 'user',
          content: `Paziente: ${paziente.nome} ${paziente.cognome}
Tipo di terapia: ${paziente.tipo_terapia || 'non specificato'}
Note generali sul paziente: ${paziente.note || 'nessuna nota disponibile'}

Richiesta dello specialista: ${richiestaFinale}`
        }
      ],
      temperature: 0.4,
      max_tokens: 2048,
    });

    const testoGenerato = completion.choices[0]?.message?.content?.trim();

    if (!testoGenerato) {
      throw new Error('Groq non ha restituito alcun contenuto.');
    }

    console.log(`--> Testo generato (${testoGenerato.length} caratteri), creo il documento...`);

    // 2. Crea un nuovo Google Doc
    const nuovoDoc = await docs.documents.create({
      requestBody: {
        title: `${paziente.nome} ${paziente.cognome} - ${new Date().toLocaleDateString('it-IT')}`,
      },
    });

    const nuovoDocId = nuovoDoc.data.documentId;

    // 3. Inserisce il testo nel documento
    await docs.documents.batchUpdate({
      documentId: nuovoDocId,
      requestBody: {
        requests: [
          {
            insertText: {
              location: { index: 1 },
              text: testoGenerato,
            },
          },
        ],
      },
    });

    // 4. Recupera il link
    const info = await drive.files.get({
      fileId: nuovoDocId,
      fields: 'webViewLink',
    });

    console.log(`--> Documento creato: ${info.data.webViewLink}`);
    res.json({ success: true, url: info.data.webViewLink });

  } catch (error) {
    console.error('Errore:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ===== Endpoint per la barra "Cerca con linguaggio naturale" della Dashboard =====
app.post('/api/ask', async (req, res) => {
  try {
    const { query, context } = req.body;

    if (!query || !query.trim()) {
      return res.status(400).json({ error: 'Campo "query" mancante.' });
    }

    console.log(`--> Domanda AI dashboard: "${query}"`);

    const completion = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      messages: [
        {
          role: 'system',
          content: `Sei un assistente per uno studio terapeutico.
Hai accesso ai dati dei pazienti forniti nel contesto.
Rispondi in italiano in modo conciso e utile.
Se trovi dati pertinenti, mostrali chiaramente.
Contesto dati: ${context || 'nessun contesto fornito'}`
        },
        { role: 'user', content: query }
      ],
      max_tokens: 500,
      temperature: 0.3,
    });

    const risposta = completion.choices[0]?.message?.content?.trim() ?? 'Nessuna risposta disponibile.';
    res.json({ answer: risposta });

  } catch (error) {
    console.error('Errore /api/ask:', error.message);
    res.status(500).json({ error: error.message, answer: 'Errore nella generazione della risposta.' });
  }
});

// ===== NUOVO: Endpoint per elencare i file da Google Drive =====
app.get('/api/drive/files', async (req, res) => {
  try {
    console.log('--> Richiesta lista file Drive');
    
    const response = await drive.files.list({
      pageSize: 50,
      fields: 'files(id, name, mimeType, size, modifiedTime)',
      orderBy: 'modifiedTime desc',
    });
    
    console.log(`--> Trovati ${response.data.files?.length || 0} file`);
    
    res.json({ 
      success: true, 
      files: response.data.files || [] 
    });
    
  } catch (error) {
    console.error('Errore lista file Drive:', error.message);
    
    // Se l'error è di autenticazione, diamo un messaggio più chiaro
    if (error.message.includes('invalid_grant')) {
      return res.status(401).json({ 
        success: false, 
        error: 'Refresh token Google non valido o scaduto. Rigeneralo su https://developers.google.com/oauthplayground' 
      });
    }
    
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// ===== NUOVO: Endpoint per scaricare un file da Google Drive =====
app.get('/api/drive/download/:fileId', async (req, res) => {
  try {
    const { fileId } = req.params;
    
    console.log(`--> Download file Drive: ${fileId}`);
    
    // Prima prendi i metadati per sapere nome e tipo
    const metadata = await drive.files.get({
      fileId: fileId,
      fields: 'name, mimeType, size',
    });
    
    const fileName = metadata.data.name || 'file';
    const mimeType = metadata.data.mimeType || 'application/octet-stream';
    
    console.log(`--> Scaricando: ${fileName} (${mimeType})`);
    
    // Poi scarica il contenuto
    const file = await drive.files.get(
      { fileId: fileId, alt: 'media' },
      { responseType: 'stream' }
    );
    
    // Imposta gli header per il download
    res.setHeader('Content-Type', mimeType);
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    
    // Invia il file
    file.data.pipe(res);
    
  } catch (error) {
    console.error('Errore download file:', error.message);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// ===== NUOVO: Endpoint per ottenere info su un file specifico =====
app.get('/api/drive/info/:fileId', async (req, res) => {
  try {
    const { fileId } = req.params;
    
    const response = await drive.files.get({
      fileId: fileId,
      fields: 'id, name, mimeType, size, modifiedTime, webViewLink',
    });
    
    res.json({ 
      success: true, 
      file: response.data 
    });
    
  } catch (error) {
    console.error('Errore info file:', error.message);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// ===== Health check =====
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    google: {
      clientId: CLIENT_ID ? 'configurato' : 'mancante',
      clientSecret: CLIENT_SECRET ? 'configurato' : 'mancante',
      refreshToken: REFRESH_TOKEN ? 'configurato' : 'mancante',
    }
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Server attivo sulla porta ${PORT}`);
  console.log(`✅ Endpoint disponibili:`);
  console.log(`   - POST /api/genera`);
  console.log(`   - POST /api/ask`);
  console.log(`   - GET  /api/drive/files`);
  console.log(`   - GET  /api/drive/download/:fileId`);
  console.log(`   - GET  /api/drive/info/:fileId`);
  console.log(`   - GET  /health`);
});
