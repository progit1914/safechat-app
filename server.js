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
const io = new Server(httpServer, { 
  cors: { 
    origin: "*",
    methods: ["GET", "POST"]
  } 
});

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// --- Data Structures ---
let users = []; // { id, gender, pref, socket }
let reports = {}; // { socketId: reportCount }
let activePairs = new Map(); // Track active conversations
const REPORT_THRESHOLD = 3;

// --- Helper Functions ---
function simpleKeywordCheck(text) {
    const blacklist = ['nude', 'sex', 'kill', 'bomb', 'suicide', 'fuck', 'shit', 'porn'];
    const low = text.toLowerCase();
    return blacklist.some(word => low.includes(word));
}

async function moderateText(text) {
    if (simpleKeywordCheck(text)) {
        return { flagged: true, reason: 'Inappropriate keyword detected' };
    }
    return { flagged: false };
}

// --- Matchmaking Logic ---
function tryMatch(socket) {
    const me = users.find(u => u.id === socket.id);
    if (!me) return;

    // Find compatible partner
    const partner = users.find(user => {
        if (user.id === me.id) return false;
        const myPrefOk = me.pref === 'any' || user.gender === me.pref;
        const theirPrefOk = user.pref === 'any' || user.pref === me.gender;
        return myPrefOk && theirPrefOk;
    });

    if (partner) {
        // Create a unique room for this pair
        const roomId = `${socket.id}-${partner.id}`;
        
        // Join both users to the room
        socket.join(roomId);
        partner.socket.join(roomId);
        
        // Store active pair
        activePairs.set(socket.id, { partnerId: partner.id, roomId });
        activePairs.set(partner.id, { partnerId: socket.id, roomId });

        // Notify both users
        socket.emit('matched', { partnerId: partner.id, roomId });
        partner.socket.emit('matched', { partnerId: socket.id, roomId });

        // Remove from waiting list
        users = users.filter(u => u.id !== me.id && u.id !== partner.id);
        
        console.log(`Matched ${socket.id} with ${partner.id} in room ${roomId}`);
    } else {
        socket.emit('waiting');
    }
}

// --- Socket.IO Event Handling ---
io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    // User joins with preferences
    socket.on('join', (userData) => {
        users.push({ 
            id: socket.id, 
            gender: userData.gender, 
            pref: userData.pref, 
            socket: socket 
        });
        tryMatch(socket);
    });

    // Text message handling
    socket.on('text-message', async (data) => {
        const pair = activePairs.get(socket.id);
        if (!pair) return;

        // Moderate message
        const moderation = await moderateText(data.message);
        if (moderation.flagged) {
            socket.emit('message-blocked', { reason: moderation.reason });
            return;
        }

        // Send to partner
        socket.to(pair.roomId).emit('text-message', {
            from: socket.id,
            message: data.message
        });
    });

    // WebRTC signaling
    socket.on('offer', (data) => {
        const pair = activePairs.get(socket.id);
        if (pair) {
            socket.to(pair.partnerId).emit('offer', {
                offer: data.offer,
                sender: socket.id
            });
        }
    });

    socket.on('answer', (data) => {
        const pair = activePairs.get(socket.id);
        if (pair) {
            socket.to(pair.partnerId).emit('answer', {
                answer: data.answer,
                sender: socket.id
            });
        }
    });

    socket.on('ice-candidate', (data) => {
        const pair = activePairs.get(socket.id);
        if (pair) {
            socket.to(pair.partnerId).emit('ice-candidate', {
                candidate: data.candidate,
                sender: socket.id
            });
        }
    });

    // Report user
    socket.on('report-user', (reportedId) => {
        reports[reportedId] = (reports[reportedId] || 0) + 1;
        
        if (reports[reportedId] >= REPORT_THRESHOLD) {
            const userSocket = io.sockets.sockets.get(reportedId);
            if (userSocket) {
                userSocket.emit('banned');
                userSocket.disconnect();
            }
        }
    });

    // Skip/next partner
    socket.on('skip-partner', () => {
        const pair = activePairs.get(socket.id);
        if (pair) {
            // Notify partner
            socket.to(pair.partnerId).emit('partner-skipped');
            
            // Clean up
            activePairs.delete(socket.id);
            activePairs.delete(pair.partnerId);
            
            // Return both to pool
            const partnerSocket = io.sockets.sockets.get(pair.partnerId);
            if (partnerSocket) {
                users.push({
                    id: partnerSocket.id,
                    gender: users.find(u => u.id === partnerSocket.id)?.gender || 'unknown',
                    pref: users.find(u => u.id === partnerSocket.id)?.pref || 'any',
                    socket: partnerSocket
                });
                partnerSocket.emit('waiting');
            }
            
            users.push({
                id: socket.id,
                gender: users.find(u => u.id === socket.id)?.gender || 'unknown',
                pref: users.find(u => u.id === socket.id)?.pref || 'any',
                socket: socket
            });
            socket.emit('waiting');
        }
    });

    // Handle disconnect
    socket.on('disconnect', () => {
        console.log('User disconnected:', socket.id);
        
        // Clean up user from all lists
        users = users.filter(u => u.id !== socket.id);
        
        const pair = activePairs.get(socket.id);
        if (pair) {
            // Notify partner
            socket.to(pair.partnerId).emit('partner-disconnected');
            activePairs.delete(socket.id);
            activePairs.delete(pair.partnerId);
        }
    });
});

// Health check endpoint for Render
app.get('/health', (req, res) => {
    res.status(200).json({ 
        status: 'OK', 
        usersWaiting: users.length,
        activePairs: activePairs.size / 2 
    });
});

// Start server
const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`Health check available at http://localhost:${PORT}/health`);
});