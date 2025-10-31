import { initializeApp } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-app.js";
import { getAuth, signInAnonymously, signInWithCustomToken, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-auth.js";
import { getFirestore, doc, setDoc, updateDoc, onSnapshot } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js";

// Global variables provided by the environment (MANDATORY USE)
const appId = typeof __app_id !== 'undefined' ? __app_id : 'scooked-default-app';
const firebaseConfig = typeof __firebase_config !== 'undefined' ? JSON.parse(__firebase_config) : null;
const initialAuthToken = typeof __initial_auth_token !== 'undefined' ? __initial_auth_token : null;

let db, auth, userId = null;
let countdownInterval = null;
const SESSION_DURATION_MS = 10 * 60 * 1000; // 10 minutes in milliseconds
const SESSION_DOC_PATH = "scooked_session/active_session";

// DOM elements
const connectButton = document.getElementById('connect-button');
const disconnectButton = document.getElementById('disconnect-button');
const statusPanel = document.getElementById('status-panel');
const statusText = document.getElementById('status-text');
const timeDisplay = document.getElementById('time-display');
const userIdDisplay = document.getElementById('user-id-display');
const userInfo = document.getElementById('user-info');
const consoleLog = document.getElementById('console-log');
const accessPortal = document.getElementById('access-portal');
const stealthUrlInput = document.getElementById('stealth-url');

// Helper function for exponential backoff (minimal implementation)
const withRetry = async (fn, maxRetries = 3, delay = 1000) => {
    for (let i = 0; i < maxRetries; i++) {
        try {
            return await fn();
        } catch (error) {
            if (i === maxRetries - 1) throw error;
            await new Promise(resolve => setTimeout(resolve, delay * (2 ** i)));
        }
    }
};

// --- Console Logging Function ---
let logCounter = 3;
function log(message, colorClass = 'text-gray-300') {
    const now = new Date();
    const time = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;
    
    // Limit log size to prevent lag
    if (consoleLog.children.length > 20) {
        consoleLog.removeChild(consoleLog.children[0]);
    }

    const logEntry = document.createElement('div');
    logEntry.innerHTML = `[${time}] ${message}`;
    logEntry.className = colorClass;
    consoleLog.appendChild(logEntry);
    consoleLog.scrollTop = consoleLog.scrollHeight; // Scroll to bottom
    logCounter++;
}


// --- Core Firebase Functions ---

/**
 * Initializes Firebase and authenticates the user.
 */
async function initFirebase() {
    if (!firebaseConfig) {
        log("ERROR: Firebase config missing. Running offline.", 'text-red-500');
        return;
    }

    try {
        const app = initializeApp(firebaseConfig);
        db = getFirestore(app);
        auth = getAuth(app);
        
        if (initialAuthToken) {
            await signInWithCustomToken(auth, initialAuthToken);
            log("NOTICE: Initial token auth SUCCESS.", 'text-cyan-400');
        } else {
            await signInAnonymously(auth);
            log("NOTICE: Signed in anonymously.", 'text-cyan-400');
        }

        onAuthStateChanged(auth, (user) => {
            if (user) {
                userId = user.uid;
                userIdDisplay.textContent = userId;
                userInfo.classList.remove('hidden');
                log(`NOTICE: Auth ready. UID: ${userId.substring(0, 8)}...`);
                listenForSessionUpdates(); 
            } else {
                userId = crypto.randomUUID(); // Fallback ID if auth fails
                userIdDisplay.textContent = userId + " (Anon)";
                userInfo.classList.remove('hidden');
                log("WARNING: Auth failed. Using random local ID.", 'text-yellow-500');
            }
        });

    } catch (error) {
        log(`FATAL ERROR: Init failed. ${error.message.substring(0, 50)}...`, 'text-red-500');
    }
}

/**
 * Listens to real-time updates for the current user's session end time.
 */
function listenForSessionUpdates() {
    if (!db || !userId) return;

    // Path for private user data: /artifacts/{appId}/users/{userId}/scooked_session/active_session
    const sessionDocRef = doc(db, 
        'artifacts', appId, 
        'users', userId, 
        SESSION_DOC_PATH.split('/')[0], SESSION_DOC_PATH.split('/')[1]
    );

    onSnapshot(sessionDocRef, (docSnapshot) => {
        if (docSnapshot.exists()) {
            const data = docSnapshot.data();
            const endTime = data.endTime;
            if (endTime) {
                log("STATE SYNC: Remote session active. Starting countdown.", 'text-blue-400');
                startCountdown(endTime);
                return;
            }
        }
        // If no session data or session ended, ensure we are in a disconnected state
        if (!countdownInterval) {
            updateStatus(false, 0);
        }
    }, (error) => {
        log(`ERROR: Firestore snapshot failure. ${error.message.substring(0, 50)}...`, 'text-red-500');
    });
}

/**
 * Saves the session end time to Firestore.
 * @param {number} endTimeMs - The timestamp in milliseconds when the session should end.
 */
async function saveSessionEndTime(endTimeMs) {
    if (!db || !userId) {
        log("WARNING: DB not ready. Skipping remote save.", 'text-yellow-500');
        return;
    }
    
    const sessionDocRef = doc(db, 
        'artifacts', appId, 
        'users', userId, 
        SESSION_DOC_PATH.split('/')[0], SESSION_DOC_PATH.split('/')[1]
    );

    try {
        await withRetry(() => setDoc(sessionDocRef, { endTime: endTimeMs, startedAt: Date.now() }));
        log("SUCCESS: Session start time written to remote endpoint.", 'text-green-500');
    } catch (e) {
        log(`ERROR: Failed to save session. ${e.message.substring(0, 50)}...`, 'text-red-500');
    }
}

/**
 * Clears the session end time from Firestore.
 */
async function clearSessionEndTime() {
    if (!db || !userId) return;

    const sessionDocRef = doc(db, 
        'artifacts', appId, 
        'users', userId, 
        SESSION_DOC_PATH.split('/')[0], SESSION_DOC_PATH.split('/')[1]
    );

    try {
        // Set endTime to null to clear it logically
        await withRetry(() => updateDoc(sessionDocRef, { endTime: null }));
        log("SUCCESS: Remote session terminated.", 'text-yellow-500');
    } catch (e) {
        log(`ERROR: Failed to clear session data. ${e.message.substring(0, 50)}...`, 'text-red-500');
    }
}

// --- UI & Timer Functions ---

/**
 * Formats time in seconds to MM:SS string.
 * @param {number} totalSeconds
 * @returns {string}
 */
function formatTime(totalSeconds) {
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = Math.floor(totalSeconds % 60);
    return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

/**
 * Updates the UI status based on connection state.
 * @param {boolean} isConnected
 * @param {number} timeRemainingSeconds
 */
function updateStatus(isConnected, timeRemainingSeconds) {
    clearInterval(countdownInterval);
    countdownInterval = null;
    
    // Enable/disable the input box based on connection state
    stealthUrlInput.disabled = !isConnected;

    if (isConnected) {
        statusPanel.classList.add('status-connected');
        statusPanel.classList.remove('status-panel-base');
        statusText.textContent = "STATUS: CONNECTION ESTABLISHED";
        connectButton.classList.add('hidden');
        disconnectButton.classList.remove('hidden');
        accessPortal.classList.remove('hidden');
        log("PROTOCOL ENGAGED: Simulated extension lockdown and traffic obfuscation.", 'text-blue-400');
    } else {
        statusPanel.classList.remove('status-connected');
        statusPanel.classList.add('status-panel-base');
        
        connectButton.classList.remove('hidden');
        disconnectButton.classList.add('hidden');
        accessPortal.classList.add('hidden');
        
        if (timeRemainingSeconds <= 0) {
            timeDisplay.textContent = "00:00";
            statusText.textContent = "STATUS: DISCONNECTED";
        }
        
        if (timeRemainingSeconds < 0) {
             statusText.textContent = "STATUS: SESSION EXPIRED. ACCESS NORMALIZED.";
             log("ALERT: Timer depleted. Session self-terminated.", 'text-red-500');
        } else if (timeRemainingSeconds === 0) {
             log("INFO: User command received. Access normalized.", 'text-green-500');
        }
    }
}

/**
 * Starts the visual countdown timer.
 * @param {number} endTimeMs - Timestamp when the session ends.
 */
function startCountdown(endTimeMs) {
    if (endTimeMs <= Date.now() || countdownInterval) return;

    clearInterval(countdownInterval); 

    updateStatus(true, (endTimeMs - Date.now()) / 1000);

    countdownInterval = setInterval(() => {
        const now = Date.now();
        const remainingMs = endTimeMs - now;
        const remainingSeconds = Math.max(0, Math.floor(remainingMs / 1000));
        
        if (remainingSeconds <= 0) {
            clearInterval(countdownInterval);
            countdownInterval = null;
            clearSessionEndTime(); // Clear the remote session data
            updateStatus(false, -1); // -1 indicates expired session
        } else {
            timeDisplay.textContent = formatTime(remainingSeconds);
            if (remainingSeconds === 60) {
                log("WARNING: One minute remaining until normalization.", 'text-yellow-500');
            }
        }
    }, 1000);
}

/**
 * Handles the click event to initiate the Scooked session.
 */
async function connectVPN() {
    if (countdownInterval) return; 

    log("COMMAND: INITIATE STEALTH MODE.", 'text-green-500');

    const startTime = Date.now();
    const endTimeMs = startTime + SESSION_DURATION_MS;
    
    await saveSessionEndTime(endTimeMs);
    startCountdown(endTimeMs);
}

/**
 * Handles the click event to disconnect the session early.
 */
async function disconnectVPN() {
    if (!countdownInterval) return;

    log("COMMAND: EMERGENCY DISCONNECT EXECUTED.", 'text-red-500');

    clearInterval(countdownInterval);
    countdownInterval = null;
    await clearSessionEndTime();
    updateStatus(false, 0); 
}

/**
 * Handles the "proxy" search/URL input (actual redirection).
 */
stealthUrlInput.addEventListener('keypress', function(e) {
    if (e.key === 'Enter' && !stealthUrlInput.disabled) {
        let query = stealthUrlInput.value.trim();
        
        if (!query) return;

        // Simple check if the input looks like a URL
        let finalUrl;
        if (query.includes('.') && !query.includes(' ')) {
            // It looks like a domain or URL
            finalUrl = query.startsWith('http') ? query : `https://${query}`;
            log(`TUNNEL: Routing directly to: ${finalUrl.substring(0, 50)}...`, 'text-blue-400');
        } else {
            // It looks like a search query
            finalUrl = `https://www.google.com/search?q=${encodeURIComponent(query)}`;
            log(`TUNNEL: Routing search query: ${query.substring(0, 30)}...`, 'text-blue-400');
        }

        // Redirect the browser
        window.location.href = finalUrl;
    }
});


// --- Initialization and Event Listeners ---

connectButton.addEventListener('click', connectVPN);
disconnectButton.addEventListener('click', disconnectVPN);

window.onload = function () {
    initFirebase();
}
