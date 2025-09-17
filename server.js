// server.js
import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { fileURLToPath } from 'url';
import path from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, { cors: { origin: "*" } });

// Serve static files (HTML, JS) from the 'public' folder
app.use(express.static(path.join(__dirname, 'public')));

// --- Data Structures ---
let users = []; // { id, gender, pref, socket }
let reports = {}; // { socketId: reportCount }
const REPORT_THRESHOLD = 3; // Ban after 3 reports

// --- Moderation Functions ---
function simpleKeywordCheck(text) {
    const blacklist = ['nude', 'sex', 'kill', 'bomb', 'suicide', 'fuck', 'shit'];
    const low = text.toLowerCase();
    return blacklist.some(word => low.includes(word));
}

async function moderateText(text) {
    // First, check with simple keywords (fast and free)
    if (simpleKeywordCheck(text)) {
        return { flagged: true, reason: 'Inappropriate keyword' };
    }
    // LATER: Add AI moderation API call here (OpenAI, Perspective API)
    return { flagged: false };
}

// --- Matchmaking Logic ---
function tryMatch(socket) {
    const me = users.find(u => u.id === socket.id);
    if (!me) return;

    // Find a partner whose gender matches my preference AND whose preference matches my gender
    let partner = users.find(user => {
        if (user.id === me.id) return false; // Skip self
        const myPrefOk = me.pref === 'any' || user.gender === me.pref;
        const theirPrefOk = user.pref === 'any' || user.pref === me.gender;
        return myPrefOk && theirPrefOk;
    });

    if (partner) {
        // Match found! Notify both users and remove them from the pool
        socket.emit('matched', { partnerId: partner.id });
        partner.socket.emit('matched', { partnerId: me.id });

        users = users.filter(u => u.id !== me.id && u.id !== partner.id);
    } else {
        // No match found, keep waiting
        socket.emit('waiting');
    }
}

// --- Socket.IO Event Handling ---
io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    socket.on('join', (userData) => {
        // userData: { gender: 'male', pref: 'female' }
        users.push({ id: socket.id, gender: userData.gender, pref: userData.pref, socket: socket });
        tryMatch(socket);
    });

    socket.on('text-message', async ({ targetId, message }) => {
        console.log(`Message from ${socket.id} to ${targetId}: ${message}`);

       async function moderateText(text) {
    // First, check with simple keywords (fast and free)
    if (simpleKeywordCheck(text)) {
        return { flagged: true, reason: 'Inappropriate keyword' };
    }

    // Try OpenAI Moderation if key is available
    const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
    
    if (!OPENAI_API_KEY) {
        console.log("No OpenAI API key found. Using keyword fallback.");
        return { flagged: false };
    }

    try {
        const response = await fetch('https://api.openai.com/v1/moderations', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${OPENAI_API_KEY}`
            },
            body: JSON.stringify({ input: text })
        });

        const data = await response.json();
        
        if (data.results[0]?.flagged) {
            return { flagged: true, reason: 'AI Moderation: Violates content policy' };
        }
        return { flagged: false };

    } catch (error) {
        console.error("Error calling OpenAI Moderation:", error);
        return { flagged: false };
    }
}

        // If message is clean, send it to the partner
        io.to(targetId).emit('text-message', { from: socket.id, message: message });
    });

    socket.on('report-user', (reportedId) => {
        console.log(`User ${reportedId} reported by ${socket.id}`);
        reports[reportedId] = (reports[reportedId] || 0) + 1;
        if (reports[reportedId] >= REPORT_THRESHOLD) {
            const userToBan = users.find(u => u.id === reportedId);
            if (userToBan) {
                userToBan.socket.emit('banned');
                users = users.filter(u => u.id !== reportedId);
                userToBan.socket.disconnect();
            }
        }
    });

    socket.on('disconnect', () => {
        console.log('User disconnected:', socket.id);
        users = users.filter(u => u.id !== socket.id);
    });
});

// Start the server
const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});