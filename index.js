require('dotenv').config();

const express = require('express');
const cors = require('cors');
const { google } = require('googleapis');
const Groq = require('groq-sdk');

const app = express();
app.use(cors());
app.use(express.json());

// ===== Credenziali Google (default - le tue) =====
const CLIENT_ID     = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const REFRESH_TOKEN = process.env.GOOGLE_REFRESH_TOKEN;

// Client default (il tuo account)
const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET);
oauth2Client.setCredentials({ refresh_token: REFRESH_TOKEN });

const drive = google.drive({ version: 'v3', auth: oauth2Client });
const docs  = google.docs({  version: 'v1', auth: oauth2Client });

// ===== Client Groq =====
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// ===== LOG DIAGNOSTICO =====
function maschera(v) {
  if (!v) return 'MANCANTE';
  return 'lunghezza=' + v.length + ', inizio="' + v.slice(0, 6) + '...", fine="...' + v.slice(-6) + '"';
}
console.log('--- DIAGNOSTICA CREDENZIALI ---');
console.log('GOOGLE_CLIENT_ID:', maschera(CLIENT_ID));
console.log('GOOGLE_CLIENT_SECRET:', maschera(CLIENT_SECRET));
console.log('GOOGLE_REFRESH_TOKEN:', maschera(REFRESH_TOKEN));
console.log('GROQ_API_KEY:', maschera(process.env.GROQ_API_KEY));
console.log('-------------------------------');

// ==========================================
// GOOGLE DRIVE - LISTA FILE
// ==========================================
app.get('/api/drive/files', async (req, res) => {
  try {
    console.log('--> Lista file Drive');
    
    const response = await drive.files.list({
      pageSize: 50,
      fields: 'files(id, name, mimeType, size, modifiedTime, webViewLink)',
      orderBy: 'modifiedTime desc',
    });
    
    console.log('--> Trovati', response.data.files?.length || 0, 'file');
    
    res.json({ 
      success: true, 
      files: response.data.files || [] 
    });
    
  } catch (error) {
    console.error('Errore lista file Drive:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==========================================
// GOOGLE DRIVE - SCARICA FILE
// ==========================================
app.get('/api/drive/download/:fileId', async (req, res) => {
  try {
    const { fileId } = req.params;
    console.log('--> Download file:', fileId);
    
    const metadata = await drive.files.get({
      fileId: fileId,
      fields: 'name, mimeType, size',
    });
    
    const fileName = metadata.data.name || 'file';
    const mimeType = metadata.data.mimeType || 'application/octet-stream';
    
    console.log('--> File:', fileName, '(', mimeType, ')');
    
    const file = await drive.files.get(
      { fileId: fileId, alt: 'media' },
      { responseType: 'stream' }
    );
    
    res.setHeader('Content-Type', mimeType);
    res.setHeader('Content-Disposition', 'attachment; filename="' + encodeURIComponent(fileName) + '"');
    
    file.data.pipe(res);
    
  } catch (error) {
    console.error('Errore download file:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==========================================
// GOOGLE DRIVE - CALLBACK WEB (per cambiare account)
// ==========================================
app.get('/api/google/callback-web', async (req, res) => {
  const { code } = req.query;
  
  if (!code) {
    return res.send('<h1>Errore: codice mancante</h1><p>Torna indietro e riprova.</p>');
  }
  
  try {
    const authClient = new google.auth.OAuth2(
      CLIENT_ID, 
      CLIENT_SECRET,
      'https://studio-backend-kzx7.onrender.com/api/google/callback-web'
    );
    
    const { tokens } = await authClient.getToken(code);
    
    res.send(
      '<html>' +
      '<body style="font-family:sans-serif;padding:30px;text-align:center;">' +
      '<h1 style="color:green;">✅ Google Drive collegato!</h1>' +
      '<p>Copia questo valore nel file <code>.env</code> del backend:</p>' +
      '<pre style="background:#f5f5f5;padding:15px;border-radius:8px;text-align:left;max-width:600px;margin:0 auto;word-break:break-all;">GOOGLE_REFRESH_TOKEN=' + tokens.refresh_token + '</pre>' +
      '<p style="color:#666;margin-top:20px;">Poi riavvia il server su Render.</p>' +
      '<button onclick="window.close()" style="padding:10px 20px;background:#4285F4;color:white;border:none;border-radius:5px;cursor:pointer;font-size:16px;">Chiudi finestra</button>' +
      '</body>' +
      '</html>'
    );
  } catch (error) {
    res.send('<h1 style="color:red;">Errore</h1><p>' + error.message + '</p>');
  }
});

// ==========================================
// GENERA DOCUMENTO AI
// ==========================================
app.post('/api/genera', async (req, res) => {
  try {
    const { paziente, richiesta } = req.body;

    if (!paziente || !paziente.nome || !paziente.cognome) {
      return res.status(400).json({ success: false, error: 'Dati paziente mancanti (nome/cognome).' });
    }

    const richiestaFinale = richiesta?.trim() ||
      'Genera una cartella clinica completa con sezioni per anamnesi, diagnosi, obiettivi terapeutici e note di seduta';

    console.log('--> Richiesta per', paziente.nome, paziente.cognome, ':', richiestaFinale);

    const completion = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      messages: [
        {
          role: 'system',
          content: 'Sei un assistente che aiuta uno psicoterapeuta a redigere documenti clinici professionali in italiano. Scrivi in modo chiaro, professionale e clinicamente appropriato. Non inventare informazioni cliniche specifiche non fornite: se mancano dati, lascia segnaposto tra parentesi quadre (es. [da completare]). Restituisci SOLO il testo del documento, senza markdown, senza intestazioni tipo "Ecco il documento", pronto per essere inserito in un Google Doc.'
        },
        {
          role: 'user',
          content: 'Paziente: ' + paziente.nome + ' ' + paziente.cognome + '\nTipo di terapia: ' + (paziente.tipo_terapia || 'non specificato') + '\nNote generali sul paziente: ' + (paziente.note || 'nessuna nota disponibile') + '\n\nRichiesta dello specialista: ' + richiestaFinale
        }
      ],
      temperature: 0.4,
      max_tokens: 2048,
    });

    const testoGenerato = completion.choices[0]?.message?.content?.trim();

    if (!testoGenerato) {
      throw new Error('Groq non ha restituito alcun contenuto.');
    }

    console.log('--> Testo generato (' + testoGenerato.length + ' caratteri), creo il documento...');

    const nuovoDoc = await docs.documents.create({
      requestBody: {
        title: paziente.nome + ' ' + paziente.cognome + ' - ' + new Date().toLocaleDateString('it-IT'),
      },
    });

    const nuovoDocId = nuovoDoc.data.documentId;

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

    const info = await drive.files.get({
      fileId: nuovoDocId,
      fields: 'webViewLink',
    });

    console.log('--> Documento creato:', info.data.webViewLink);
    res.json({ success: true, url: info.data.webViewLink });

  } catch (error) {
    console.error('Errore:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==========================================
// ASK AI
// ==========================================
app.post('/api/ask', async (req, res) => {
  try {
    const { query, context } = req.body;

    if (!query || !query.trim()) {
      return res.status(400).json({ error: 'Campo "query" mancante.' });
    }

    console.log('--> Domanda AI dashboard:', query);

    const completion = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      messages: [
        {
          role: 'system',
          content: 'Sei un assistente per uno studio terapeutico. Hai accesso ai dati dei pazienti forniti nel contesto. Rispondi in italiano in modo conciso e utile. Se trovi dati pertinenti, mostrali chiaramente. Contesto dati: ' + (context || 'nessun contesto fornito')
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

// ==========================================
// HEALTH CHECK
// ==========================================
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    google: {
      clientId: CLIENT_ID ? 'configurato' : 'mancante',
      clientSecret: CLIENT_SECRET ? 'configurato' : 'mancante',
      refreshToken: REFRESH_TOKEN ? 'configurato' : 'mancante',
    },
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('Server attivo sulla porta ' + PORT);
});
