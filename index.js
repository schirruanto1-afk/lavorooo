const express = require('express');
const cors = require('cors');
const { google } = require('googleapis');

const app = express();
app.use(cors()); // Permette alla tua app di comunicare con questo server
app.use(express.json());

// Configura le tue chiavi di Google (lasciale vuote se usi solo il refresh token, ma è meglio averle)
const CLIENT_ID = 'IL_TUO_CLIENT_ID.apps.googleusercontent.com';
const CLIENT_SECRET = 'IL_TUO_CLIENT_SECRET';
const REFRESH_TOKEN = 'AQ.Ab8RN6L0ep2wETk7cXd2nPQFGtlzLZGHl-kAyY9TatwA7tFzCA'; 

const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET);
oauth2Client.setCredentials({ refresh_token: REFRESH_TOKEN });

const drive = google.drive({ version: 'v3', auth: oauth2Client });
const docs = google.docs({ version: 'v1', auth: oauth2Client });

// L'ID del tuo modello Google Doc originale (prendilo dall'URL del file su Drive)
const TEMPLATE_FILE_ID = 'INSERISCI_QUI_ID_DEL_TUO_DOC_MODELLO';

app.post('/api/genera', async (req, res) => {
  try {
    const { paziente } = req.body;
    console.log("--> Ricevuta richiesta per:", paziente.nome, paziente.cognome);

    // 1. Copia il modello
    const copia = await drive.files.copy({
      fileId: TEMPLATE_FILE_ID,
      requestBody: {
        name: `Cartella - ${paziente.nome} ${paziente.cognome}`,
        mimeType: 'application/vnd.google-apps.document',
      },
    });

    const nuovoDocId = copia.data.id;

    // 2. Sostituisci i testi {{nome}}, {{cognome}}, {{note}}
    const requests = [
      { replaceAllText: { containsText: { text: '{{nome}}', matchCase: true }, replaceText: paziente.nome } },
      { replaceAllText: { containsText: { text: '{{cognome}}', matchCase: true }, replaceText: paziente.cognome } },
      { replaceAllText: { containsText: { text: '{{note}}', matchCase: true }, replaceText: paziente.note || 'Nessuna' } },
    ];

    await docs.documents.batchUpdate({
      documentId: nuovoDocId,
      requestBody: { requests },
    });

    // 3. Prendi il link finale
    const info = await drive.files.get({
      fileId: nuovoDocId,
      fields: 'webViewLink',
    });

    // Rispondi all'app inviando il link del file appena creato
    res.json({ success: true, url: info.data.webViewLink });

  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Render assegna la porta automaticamente tramite process.env.PORT
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server attivo sulla porta ${PORT}`));
