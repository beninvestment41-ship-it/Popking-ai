Import React, { useState, useEffect, useCallback, useRef } from 'react';

// --- FIREBASE IMPORTS ---
import { initializeApp } from 'firebase/app';
import { getAuth, signInAnonymously, signInWithCustomToken, onAuthStateChanged } from 'firebase/auth';
import { getFirestore, collection, doc, query, orderBy, limit, setDoc, onSnapshot, updateDoc, arrayUnion, getDocs, deleteDoc } from 'firebase/firestore';

// --- LUCIDE ICONS (for sleek UI) ---
import { MessageSquareText, SearchCode, Lightbulb, GraduationCap, Code, HeartHandshake, Crown, Settings, Share2, History, X, Send, Mic, Volume2, Image as ImageIcon, BookOpen, Clock, Zap, User, Star, Loader2, Copy } from 'lucide-react';

// --- CONSTANTS & CONFIGURATION ---
const GEMINI_TEXT_MODEL = 'gemini-2.5-flash-preview-09-2025';
const GEMINI_TTS_MODEL = 'gemini-2.5-flash-preview-tts';
const IMAGEN_MODEL = 'imagen-4.0-generate-001';
const API_KEY = ""; // Uses Canvas environment key

// Global utility for unique ID (better than random UUID in some contexts)
const generateId = () => Date.now().toString(36) + Math.random().toString(36).substring(2, 5);

const MODES = {
    QUICK_CHAT: { name: "Quick Chat", icon: MessageSquareText, color: "text-blue-400", description: "Casual conversation and fast answers." },
    DEEP_SEARCH: { name: "Deep Search", icon: SearchCode, color: "text-green-400", description: "Research, web grounding, and detailed explanations." },
    CREATIVE: { name: "Creative Mode", icon: Lightbulb, color: "text-purple-400", description: "Brainstorming, stories, and art ideas." },
    STUDY: { name: "Study Mode", icon: GraduationCap, color: "text-yellow-400", description: "Summarize, quiz, and learning aids." },
    CODE: { name: "Code Mode", icon: Code, color: "text-red-400", description: "Coding assistance, debugging, and samples." },
    LIFE_COACH: { name: "Life Coach", icon: HeartHandshake, color: "text-pink-400", description: "Personal advice and motivational guidance." },
};

const PERSONAS = {
    FRIENDLY: "A friendly and helpful companion who uses positive and encouraging language.",
    MOTIVATIONAL: "A high-energy, motivational coach focused on inspiring action and goal achievement.",
    STRICT_TUTOR: "A strict but fair academic tutor who focuses on accuracy, clarity, and precision.",
    FUNNY: "A humorous and witty AI that includes light jokes and playful language in every response.",
    CREATIVE: "An imaginative and descriptive storyteller and idea generator.",
    ANALYTICAL: "A concise and highly analytical expert who provides structured, objective findings."
};

const INITIAL_SETTINGS = {
    persona: "FRIENDLY",
    creativity: 0.7, // Mapped to temperature
    voice: "Kore", // Default TTS voice (Voice: Kore (Firm))
    activeMode: "QUICK_CHAT",
    level: "Normal" // For premium feature mock
};

// --- API HELPER FUNCTIONS ---

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Generalized fetch with exponential backoff
const performFetch = async (url, payload, retries = 3) => {
    for (let i = 0; i < retries; i++) {
        try {
            const response = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            if (response.ok) {
                return response.json();
            } else if (response.status === 429 && i < retries - 1) { // Rate limit
                await delay(Math.pow(2, i) * 1000);
            } else {
                const errorBody = await response.json();
                console.error("API Error:", response.status, errorBody);
                throw new Error(`API request failed with status ${response.status}: ${JSON.stringify(errorBody)}`);
            }
        } catch (error) {
            if (i === retries - 1) throw error;
            await delay(Math.pow(2, i) * 1000);
        }
    }
};

// PCM to WAV conversion utilities for TTS
const base64ToArrayBuffer = (base64) => {
    const binaryString = atob(base64);
    const len = binaryString.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
        bytes[i] = binaryString.charCodeAt(i);
    }
    return bytes.buffer;
};

const pcmToWav = (pcm16, sampleRate = 24000) => {
    const numChannels = 1;
    const numSamples = pcm16.length;
    const buffer = new ArrayBuffer(44 + numSamples * 2);
    const view = new DataView(buffer);

    // RIFF identifier 'RIFF'
    view.setUint32(0, 0x52494646, false);
    // file size (expected to be 44 + numSamples * 2 - 8)
    view.setUint32(4, 36 + numSamples * 2, true);
    // 'WAVE' identifier
    view.setUint32(8, 0x57415645, false);
    // fmt chunk identifier 'fmt '
    view.setUint32(12, 0x666d7420, false);
    // fmt chunk size (16 for PCM)
    view.setUint32(16, 16, true);
    // audio format (1 for PCM)
    view.setUint16(20, 1, true);
    // number of channels
    view.setUint16(22, numChannels, true);
    // sample rate
    view.setUint32(24, sampleRate, true);
    // byte rate (sampleRate * numChannels * 2)
    view.setUint32(28, sampleRate * numChannels * 2, true);
    // block align (numChannels * 2)
    view.setUint16(32, numChannels * 2, true);
    // bits per sample (16)
    view.setUint16(34, 16, true);
    // data chunk identifier 'data'
    view.setUint32(36, 0x64617461, false);
    // data chunk size (numSamples * 2)
    view.setUint32(40, numSamples * 2, true);

    // Write PCM data
    let offset = 44;
    for (let i = 0; i < numSamples; i++) {
        view.setInt16(offset, pcm16[i], true);
        offset += 2;
    }

    return new Blob([buffer], { type: 'audio/wav' });
};


// --- REACT MAIN COMPONENT ---

const App = () => {
    // --- FIREBASE STATE & INITIALIZATION ---
    const [db, setDb] = useState(null);
    const [auth, setAuth] = useState(null);
    const [userId, setUserId] = useState(null);
    const [isAuthReady, setIsAuthReady] = useState(false);

    // --- APP STATE ---
    const [queryInput, setQueryInput] = useState('');
    const [chats, setChats] = useState([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);
    const [settings, setSettings] = useState(INITIAL_SETTINGS);
    const [showSettings, setShowSettings] = useState(false);
    const [showHistory, setShowHistory] = useState(false);
    const [history, setHistory] = useState([]);
    const [activeTab, setActiveTab] = useState('Text'); // Text, Images, Study, Code
    const [imagePrompt, setImagePrompt] = useState('');
    const [dailyChallenge, setDailyChallenge] = useState(null);
    const [crownRewards, setCrownRewards] = useState(0);

    const chatContainerRef = useRef(null);
    const audioRef = useRef(new Audio());

    const { persona, creativity, activeMode, voice } = settings;
    const modeConfig = MODES[activeMode];

    // --- FIREBASE INITIALIZATION EFFECT ---
    useEffect(() => {
        const appId = typeof __app_id !== 'undefined' ? __app_id : 'default-app-id';
        const firebaseConfig = typeof __firebase_config !== 'undefined' ? JSON.parse(__firebase_config) : null;
        const initialAuthToken = typeof __initial_auth_token !== 'undefined' ? __initial_auth_token : null;

        if (firebaseConfig) {
            try {
                const app = initializeApp(firebaseConfig);
                const firestore = getFirestore(app);
                const authentication = getAuth(app);

                setDb(firestore);
                setAuth(authentication);

                const unsubscribe = onAuthStateChanged(authentication, async (user) => {
                    if (user) {
                        setUserId(user.uid);
                    } else if (initialAuthToken) {
                        // Sign in with custom token if available
                        try {
                            await signInWithCustomToken(authentication, initialAuthToken);
                        } catch (e) {
                            console.error("Custom token sign-in failed. Falling back to anonymous.", e);
                            await signInAnonymously(authentication);
                        }
                    } else {
                        // Sign in anonymously if no token is available
                        await signInAnonymously(authentication);
                    }
                    setIsAuthReady(true);
                });

                // Mock Daily Challenge on load
                setDailyChallenge({
                    type: "Creative Prompt",
                    prompt: "Write a 3-sentence micro-story about a robot who discovered rain.",
                    reward: 5,
                    completed: false
                });

                return () => unsubscribe();
            } catch (e) {
                console.error("Firebase initialization failed:", e);
                setError("Failed to initialize database connection.");
            }
        } else {
            setIsAuthReady(true);
            console.warn("Firebase config not found. History/Favorites will not work.");
        }
    }, []);

    // --- FIRESTORE UTILITIES ---
    const getHistoryCollectionRef = (dbInstance, uid) => {
        const appId = typeof __app_id !== 'undefined' ? __app_id : 'default-app-id';
        return collection(dbInstance, `/artifacts/${appId}/users/${uid}/chats`);
    };

    const getRewardsDocRef = (dbInstance, uid) => {
        const appId = typeof __app_id !== 'undefined' ? __app_id : 'default-app-id';
        return doc(dbInstance, `/artifacts/${appId}/users/${uid}/metadata/rewards`);
    };

    // Load History and Rewards
    useEffect(() => {
        if (db && userId) {
            // Load Chats
            const chatQuery = query(getHistoryCollectionRef(db, userId), orderBy('timestamp', 'desc'), limit(50));
            const unsubscribeChats = onSnapshot(chatQuery, (snapshot) => {
                const loadedHistory = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
                setHistory(loadedHistory);
            }, (err) => console.error("History listen error:", err));

            // Load Rewards
            const rewardsRef = getRewardsDocRef(db, userId);
            const unsubscribeRewards = onSnapshot(rewardsRef, (docSnap) => {
                if (docSnap.exists()) {
                    setCrownRewards(docSnap.data().points || 0);
                    setSettings(prev => ({ ...prev, ...docSnap.data().settings }));
                } else {
                    // Initialize rewards doc
                    setDoc(rewardsRef, { points: 0, settings: INITIAL_SETTINGS }, { merge: true });
                }
            }, (err) => console.error("Rewards listen error:", err));

            return () => {
                unsubscribeChats();
                unsubscribeRewards();
            };
        }
    }, [db, userId]);

    // Scroll to bottom of chat
    useEffect(() => {
        if (chatContainerRef.current) {
            chatContainerRef.current.scrollTop = chatContainerRef.current.scrollHeight;
        }
    }, [chats]);

    // --- GENERAL HANDLERS ---
    const handleSettingChange = (key, value) => {
        setSettings(prev => ({ ...prev, [key]: value }));
        if (db && userId && key !== 'activeMode' && key !== 'activeTab') {
            updateDoc(getRewardsDocRef(db, userId), { [`settings.${key}`]: value });
        }
    };

    const saveChat = useCallback(async (chatData) => {
        if (!db || !userId) return;
        try {
            const chatRef = doc(getHistoryCollectionRef(db, userId));
            await setDoc(chatRef, { ...chatData, timestamp: Date.now() });
        } catch (e) {
            console.error("Error saving chat:", e);
        }
    }, [db, userId]);

    const toggleFavorite = async (chatId) => {
        const chatToUpdate = history.find(c => c.id === chatId);
        if (!chatToUpdate) return;
        const newIsFavorite = !chatToUpdate.isFavorite;

        try {
            const chatRef = doc(getHistoryCollectionRef(db, userId), chatId);
            await updateDoc(chatRef, { isFavorite: newIsFavorite });
            setCrownRewards(prev => prev + (newIsFavorite ? 1 : -1)); // Reward for favoring
        } catch (e) {
            console.error("Error toggling favorite:", e);
        }
    };

    // --- GEMINI API CALLERS ---

    const generateTextContent = useCallback(async (textPrompt) => {
        setLoading(true);
        setError(null);

        const isDeepSearch = activeMode === "DEEP_SEARCH";
        const systemPrompt = `You are PopKing AI, currently operating in the ${MODES[activeMode].name}. Your persona is set to: ${PERSONAS[persona]}. Follow the persona and the mode rules strictly.`;

        const payload = {
            contents: [{ parts: [{ text: textPrompt }] }],
            systemInstruction: { parts: [{ text: systemPrompt }] },
            generationConfig: {
                temperature: creativity,
            },
            tools: isDeepSearch ? [{ "google_search": {} }] : [],
        };

        try {
            const result = await performFetch(
                `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_TEXT_MODEL}:generateContent?key=${API_KEY}`,
                payload
            );

            const responseText = result.candidates?.[0]?.content?.parts?.[0]?.text || "Could not generate a response.";
            const groundingMetadata = result.candidates?.[0]?.groundingMetadata;

            const newChat = {
                id: generateId(),
                user: textPrompt,
                ai: responseText,
                mode: activeMode,
                persona: persona,
                timestamp: Date.now(),
                isFavorite: false,
                sources: [],
            };

            if (groundingMetadata && groundingMetadata.groundingAttributions) {
                newChat.sources = groundingMetadata.groundingAttributions
                    .map(attr => ({ uri: attr.web?.uri, title: attr.web?.title }))
                    .filter(source => source.uri);
            }

            setChats(prev => [...prev, newChat]);
            saveChat(newChat);

        } catch (e) {
            console.error(e);
            setError("Text generation failed. Please try again.");
        } finally {
            setLoading(false);
        }
    }, [activeMode, persona, creativity, saveChat]);

    const generateImageContent = useCallback(async (imageQuery) => {
        setLoading(true);
        setError(null);
        setChats(prev => [...prev, { id: generateId(), user: imageQuery, ai: "Generating image...", mode: "Image Gen", timestamp: Date.now(), isImage: true }]);

        const payload = {
            instances: [{
                prompt: imageQuery,
                config: {
                    number_of_images: 1,
                    output_mime_type: "image/png"
                }
            }]
        };

        try {
            const result = await performFetch(
                `https://generativelanguage.googleapis.com/v1beta/models/${IMAGEN_MODEL}:predict?key=${API_KEY}`,
                payload
            );

            const base64Data = result.predictions?.[0]?.bytesBase64Encoded;

            if (base64Data) {
                const imageUrl = `data:image/png;base64,${base64Data}`;
                const newImageChat = {
                    id: generateId(),
                    user: imageQuery,
                    ai: "AI Image Generated",
                    mode: "Image Gen",
                    timestamp: Date.now(),
                    isFavorite: false,
                    isImage: true,
                    imageUrl: imageUrl,
                };
                setChats(prev => prev.map(c => c.id === newImageChat.id ? newImageChat : c)); // Update 'Generating...' message
                saveChat(newImageChat);
                setCrownRewards(prev => prev + 10);
            } else {
                throw new Error("No image data received.");
            }
        } catch (e) {
            console.error(e);
            setError("Image generation failed. Ensure your prompt is safe and descriptive.");
        } finally {
            setLoading(false);
        }
    }, [saveChat]);

    const generateStructuredStudyContent = useCallback(async (studyQuery) => {
        setLoading(true);
        setError(null);

        const systemPrompt = `You are PopKing AI, acting as a Study Assistant. Based on the user's request: "${studyQuery}", generate a set of 5-8 flashcards or 3-5 quiz questions formatted as a JSON array.`;

        const responseSchema = {
            type: "ARRAY",
            items: {
                type: "OBJECT",
                properties: {
                    "type": { "type": "STRING", "description": "flashcard or quiz" },
                    "question": { "type": "STRING" },
                    "answer": { "type": "STRING" }, // Or correct answer for quiz
                    "options": { "type": "ARRAY", "items": { "type": "STRING" }, "description": "Only for quiz type, list 3 incorrect options plus the answer." }
                },
                required: ["type", "question", "answer"]
            }
        };

        const payload = {
            contents: [{ parts: [{ text: studyQuery }] }],
            systemInstruction: { parts: [{ text: systemPrompt }] },
            generationConfig: {
                responseMimeType: "application/json",
                responseSchema: responseSchema,
                temperature: creativity,
            },
        };

        try {
            const result = await performFetch(
                `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_TEXT_MODEL}:generateContent?key=${API_KEY}`,
                payload
            );

            const jsonString = result.candidates?.[0]?.content?.parts?.[0]?.text;
            let structuredData = [];
            let responseText = "Study materials generated successfully.";

            try {
                structuredData = JSON.parse(jsonString);
            } catch (e) {
                responseText = "Failed to parse structured response. Showing raw text instead: " + jsonString;
                structuredData = null;
            }

            const newChat = {
                id: generateId(),
                user: studyQuery,
                ai: responseText,
                mode: activeMode,
                persona: persona,
                timestamp: Date.now(),
                isFavorite: false,
                isStructuredStudy: true,
                structuredData: structuredData,
            };

            setChats(prev => [...prev, newChat]);
            saveChat(newChat);

        } catch (e) {
            console.error(e);
            setError("Study material generation failed. Please refine your request.");
        } finally {
            setLoading(false);
        }
    }, [activeMode, persona, creativity, saveChat]);


    const generateTTSAudio = useCallback(async (textToSpeak) => {
        setLoading(true);
        setError(null);
        audioRef.current.pause();

        const payload = {
            contents: [{ parts: [{ text: textToSpeak }] }],
            generationConfig: {
                responseModalities: ["AUDIO"],
                speechConfig: {
                    voiceConfig: {
                        prebuiltVoiceConfig: { voiceName: voice }
                    }
                }
            },
            model: GEMINI_TTS_MODEL
        };

        try {
            const result = await performFetch(
                `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_TTS_MODEL}:generateContent?key=${API_KEY}`,
                payload
            );

            const part = result?.candidates?.[0]?.content?.parts?.[0];
            const audioData = part?.inlineData?.data;
            const mimeType = part?.inlineData?.mimeType;

            if (audioData && mimeType && mimeType.startsWith("audio/")) {
                const sampleRateMatch = mimeType.match(/rate=(\d+)/);
                const sampleRate = sampleRateMatch ? parseInt(sampleRateMatch[1], 10) : 24000;
                const pcmData = base64ToArrayBuffer(audioData);

                // API returns signed PCM16 audio data.
                const pcm16 = new Int16Array(pcmData);
                const wavBlob = pcmToWav(pcm16, sampleRate);
                const audioUrl = URL.createObjectURL(wavBlob);

                audioRef.current.src = audioUrl;
                audioRef.current.play();
                setLoading(false);

                // Revoke URL after play completion to save memory
                audioRef.current.onended = () => URL.revokeObjectURL(audioUrl);
            } else {
                throw new Error("Invalid audio response structure.");
            }
        } catch (e) {
            console.error(e);
            setError("Text-to-Speech failed. Try a shorter message.");
            setLoading(false);
        }
    }, [voice]);

    // --- SUBMIT HANDLER ---

    const handleSubmit = (e) => {
        e.preventDefault();
        if (loading || !queryInput.trim()) return;

        const trimmedQuery = queryInput.trim();
        setQueryInput('');
        setError(null);

        if (activeTab === 'Images') {
            generateImageContent(trimmedQuery);
        } else if (activeTab === 'Study' && (trimmedQuery.toLowerCase().includes('quiz') || trimmedQuery.toLowerCase().includes('flashcard'))) {
            generateStructuredStudyContent(trimmedQuery);
        } else {
            generateTextContent(trimmedQuery);
        }
    };

    // --- UI COMPONENTS ---

    const Header = () => (
        <header className="flex items-center justify-between p-4 bg-gray-900 border-b border-gray-700 shadow-lg">
            <div className="flex items-center space-x-2">
                <Crown className="w-6 h-6 text-yellow-400" />
                <span className="text-xl font-bold text-white">PopKing AI</span>
                <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${modeConfig.color} bg-gray-800 border ${modeConfig.color.replace('text', 'border')}`}>
                    {modeConfig.name}
                </span>
            </div>
            <div className="flex items-center space-x-2">
                <div className="flex items-center text-yellow-400 bg-gray-800 p-1 rounded-full text-sm font-semibold">
                    <Crown className="w-4 h-4 mr-1" fill="#FBBF24" />
                    {crownRewards}
                </div>
                <button onClick={() => setShowHistory(true)} className="p-2 text-gray-400 hover:text-white rounded-full transition-colors">
                    <History className="w-5 h-5" />
                </button>
                <button onClick={() => setShowSettings(true)} className="p-2 text-gray-400 hover:text-white rounded-full transition-colors">
                    <Settings className="w-5 h-5" />
                </button>
            </div>
        </header>
    );

    const ModeSwitch = () => (
        <div className="p-4 bg-gray-800 border-b border-gray-700 grid grid-cols-3 gap-2 text-center text-sm">
            {Object.keys(MODES).map(key => {
                const mode = MODES[key];
                const isActive = activeMode === key;
                return (
                    <button
                        key={key}
                        onClick={() => handleSettingChange('activeMode', key)}
                        className={`p-2 rounded-lg transition-all border ${isActive ? `bg-gray-900 ${mode.color.replace('text', 'border')}` : 'bg-gray-700 border-transparent text-gray-300 hover:bg-gray-600'}`}
                        title={mode.description}
                    >
                        <mode.icon className={`w-4 h-4 mx-auto mb-1 ${mode.color}`} />
                        {mode.name.replace(' Mode', '')}
                    </button>
                );
            })}
        </div>
    );

    const TabBar = () => (
        <div className="flex justify-around bg-gray-900 border-t border-gray-700">
            {['Text', 'Images', 'Study', 'Code'].map(tab => {
                const isActive = activeTab === tab;
                const Icon = {
                    Text: MessageSquareText,
                    Images: ImageIcon,
                    Study: BookOpen,
                    Code: Code
                }[tab];

                return (
                    <button
                        key={tab}
                        onClick={() => setActiveTab(tab)}
                        className={`flex-1 p-3 text-sm font-medium transition-colors border-b-2 ${isActive ? 'text-yellow-400 border-yellow-400' : 'text-gray-400 border-transparent hover:text-white'}`}
                    >
                        <Icon className="w-5 h-5 mx-auto mb-1" />
                        {tab}
                    </button>
                );
            })}
        </div>
    );

    const ChatMessage = ({ chat }) => {
        const isUser = chat.user && !chat.ai;
        const isImage = chat.isImage;

        const handleShare = () => {
            const content = isImage ? `PopKing AI Image Prompt: ${chat.user}` : `${chat.user}\n\n---\n\nPopKing AI Response (${chat.mode}):\n${chat.ai}`;
            navigator.clipboard.writeText(content).then(() => {
                alert("Content copied to clipboard for sharing!");
            }).catch(err => {
                console.error('Could not copy text: ', err);
            });
        };

        const handleTTS = () => {
            if (chat.ai) {
                generateTTSAudio(chat.ai);
            }
        };

        const renderStudyContent = (data) => (
            <div className="mt-2 space-y-3 p-3 bg-gray-700/50 rounded-lg">
                <h4 className="text-yellow-400 font-bold border-b border-yellow-400/30 pb-1">Generated Study Materials</h4>
                {data.map((item, index) => (
                    <details key={index} className="bg-gray-800 p-3 rounded-lg border border-gray-600">
                        <summary className="font-semibold text-white cursor-pointer hover:text-yellow-300">
                            {item.type === 'quiz' ? `Quiz Q${index + 1}: ` : `Flashcard ${index + 1}: `}
                            {item.question}
                        </summary>
                        <div className="mt-2 pt-2 border-t border-gray-600 text-gray-300">
                            {item.type === 'quiz' ? (
                                <div>
                                    <p className="font-medium text-green-400">Answer: {item.answer}</p>
                                    <p className="text-sm">Options: {item.options?.join(' | ') || 'N/A'}</p>
                                </div>
                            ) : (
                                <p>Answer: {item.answer}</p>
                            )}
                        </div>
                    </details>
                ))}
            </div>
        );

        return (
            <div className={`flex w-full mb-4 ${isUser ? 'justify-end' : 'justify-start'}`}>
                <div className={`max-w-[90%] md:max-w-[75%] p-3 rounded-xl shadow-lg transition-all ${isUser
                    ? 'bg-blue-600 text-white rounded-br-none'
                    : 'bg-gray-700 text-gray-50 rounded-bl-none'
                    }`}>
                    {isUser ? (
                        <p>{chat.user}</p>
                    ) : (
                        <div>
                            <div className="flex items-center mb-1">
                                <Crown className={`w-4 h-4 mr-2 ${modeConfig.color}`} />
                                <span className={`text-xs font-semibold ${modeConfig.color}`}>{chat.mode} Response</span>
                            </div>
                            {isImage ? (
                                <div className="mt-2 text-center">
                                    {chat.imageUrl ? (
                                        <img src={chat.imageUrl} alt={chat.user} className="max-w-full h-auto rounded-lg" />
                                    ) : (
                                        <div className="p-8 bg-gray-800 rounded-lg flex items-center justify-center">
                                            <Loader2 className="w-5 h-5 text-purple-400 animate-spin mr-2" />
                                            <span className="text-sm">Generating image...</span>
                                        </div>
                                    )}
                                </div>
                            ) : (
                                <div className="prose prose-sm prose-invert break-words">
                                    <p>{chat.ai}</p>
                                    {chat.isStructuredStudy && chat.structuredData && renderStudyContent(chat.structuredData)}

                                    {chat.sources && chat.sources.length > 0 && (
                                        <div className="mt-3 pt-2 border-t border-gray-600">
                                            <p className="text-xs font-semibold text-green-400 mb-1">Sources (Web Grounding):</p>
                                            <ul className="list-disc list-inside space-y-0.5 text-xs text-gray-400">
                                                {chat.sources.slice(0, 3).map((s, i) => (
                                                    <li key={i}><a href={s.uri} target="_blank" rel="noopener noreferrer" className="hover:underline">{s.title || s.uri}</a></li>
                                                ))}
                                            </ul>
                                        </div>
                                    )}
                                </div>
                            )}

                            {/* Action Bar */}
                            {chat.ai && (
                                <div className="mt-2 pt-2 border-t border-gray-600 flex justify-end space-x-2">
                                    <button onClick={handleTTS} className="text-gray-400 hover:text-yellow-400 p-1 rounded-full transition-colors" title="Text-to-Speech">
                                        <Volume2 className="w-4 h-4" />
                                    </button>
                                    <button onClick={() => toggleFavorite(chat.id)} className={`p-1 rounded-full transition-colors ${chat.isFavorite ? 'text-red-400 fill-red-400' : 'text-gray-400 hover:text-red-400'}`} title="Favorite">
                                        <Star className="w-4 h-4" fill={chat.isFavorite ? 'currentColor' : 'none'} />
                                    </button>
                                    <button onClick={handleShare} className="text-gray-400 hover:text-blue-400 p-1 rounded-full transition-colors" title="Share/Export">
                                        <Share2 className="w-4 h-4" />
                                    </button>
                                </div>
                            )}
                        </div>
                    )}
                </div>
            </div>
        );
    };

    const ChatInterface = () => (
        <div className="flex flex-col h-full">
            {/* Chat History Area */}
            <div ref={chatContainerRef} className="flex-1 overflow-y-auto p-4 bg-gray-900">
                {chats.length === 0 && (
                    <div className="text-center p-10 text-gray-500">
                        <Zap className="w-10 h-10 mx-auto mb-3 text-purple-400" />
                        <h3 className="text-lg font-semibold text-white">Welcome to PopKing AI!</h3>
                        <p className="text-sm mt-1">Select a mode and start chatting or generating content.</p>
                        <p className={`text-xs mt-2 p-1 rounded bg-gray-800 ${modeConfig.color}`}>{modeConfig.description}</p>
                    </div>
                )}
                {chats.map(chat => (
                    <ChatMessage key={chat.id} chat={chat} />
                ))}
                {loading && (
                    <div className="flex justify-start">
                        <div className="max-w-[75%] p-3 rounded-xl rounded-bl-none bg-gray-700 text-gray-50">
                            <Loader2 className="w-4 h-4 animate-spin inline mr-2 text-purple-400" />
                            <span className="text-sm">AI is thinking...</span>
                        </div>
                    </div>
                )}
                {error && (
                    <div className="text-red-400 bg-red-900/50 p-3 rounded-lg mt-4">
                        <strong>Error:</strong> {error}
                    </div>
                )}
            </div>

            {/* Input Area */}
            <form onSubmit={handleSubmit} className="p-4 bg-gray-900 border-t border-gray-700 flex items-center space-x-2">
                <button
                    type="button"
                    onClick={() => setError("STT is not available in this environment. Please type your query.")}
                    className="p-3 bg-gray-700 text-white rounded-full hover:bg-gray-600 transition-colors"
                    title="Speech-to-Text (Unavailable)"
                >
                    <Mic className="w-5 h-5" />
                </button>
                <input
                    type="text"
                    value={queryInput}
                    onChange={(e) => setQueryInput(e.target.value)}
                    placeholder={activeTab === 'Images' ? 'Describe the art you want to generate...' : 'Ask PopKing AI a question...'}
                    className="flex-1 p-3 rounded-full bg-gray-800 text-white placeholder-gray-500 focus:ring-2 focus:ring-purple-500 focus:outline-none border border-gray-700"
                    disabled={loading}
                />
                <button
                    type="submit"
                    className={`p-3 rounded-full transition-all text-white shadow-lg ${loading ? 'bg-gray-500 cursor-not-allowed' : 'bg-purple-600 hover:bg-purple-500'}`}
                    disabled={loading || !queryInput.trim()}
                >
                    {loading ? <Loader2 className="w-5 h-5 animate-spin" /> : <Send className="w-5 h-5" />}
                </button>
            </form>
        </div>
    );

    const SettingsModal = () => (
        <Modal title="Settings & Customization" onClose={() => setShowSettings(false)}>
            <div className="space-y-6">
                <h3 className="text-lg font-semibold text-yellow-400 border-b border-gray-700 pb-2">AI Persona</h3>
                <div className="grid grid-cols-2 gap-3">
                    {Object.keys(PERSONAS).map(key => (
                        <button
                            key={key}
                            onClick={() => handleSettingChange('persona', key)}
                            className={`p-3 rounded-lg text-sm transition-all border ${settings.persona === key
                                ? 'bg-purple-600 border-purple-400 text-white'
                                : 'bg-gray-700 border-gray-600 text-gray-300 hover:bg-gray-600'}`}
                        >
                            {key.split('_').map(word => word.charAt(0) + word.slice(1).toLowerCase()).join(' ')}
                        </button>
                    ))}
                </div>

                <h3 className="text-lg font-semibold text-yellow-400 border-b border-gray-700 pb-2">Creativity Level (Temperature)</h3>
                <div>
                    <input
                        type="range"
                        min="0.0"
                        max="1.0"
                        step="0.1"
                        value={settings.creativity}
                        onChange={(e) => handleSettingChange('creativity', parseFloat(e.target.value))}
                        className="w-full h-2 bg-gray-700 rounded-lg appearance-none cursor-pointer range-lg focus:outline-none focus:ring-2 focus:ring-purple-500"
                    />
                    <div className="flex justify-between text-xs text-gray-400 mt-1">
                        <span>Factual (0.0)</span>
                        <span className="text-purple-400 font-semibold">{settings.creativity.toFixed(1)}</span>
                        <span>Imaginative (1.0)</span>
                    </div>
                </div>

                <h3 className="text-lg font-semibold text-yellow-400 border-b border-gray-700 pb-2">Voice (TTS)</h3>
                <select
                    value={settings.voice}
                    onChange={(e) => handleSettingChange('voice', e.target.value)}
                    className="w-full p-3 rounded-lg bg-gray-800 border border-gray-700 text-white focus:ring-purple-500 focus:border-purple-500"
                >
                    {['Kore (Firm)', 'Zephyr (Bright)', 'Charon (Informative)', 'Puck (Upbeat)', 'Fenrir (Excitable)'].map(v => (
                        <option key={v} value={v.split(' ')[0]}>{v}</option>
                    ))}
                </select>

                <h3 className="text-lg font-semibold text-yellow-400 border-b border-gray-700 pb-2">Subscription Mock</h3>
                <div className="p-4 bg-gray-800 rounded-lg">
                    <p className="text-sm font-medium text-gray-300">Current Plan: <span className="text-green-400 font-bold">{settings.level}</span></p>
                    <p className="text-xs text-gray-400 mt-1">Premium subscription unlocks advanced modes and longer answers.</p>
                    <button
                        onClick={() => alert("Mock: Upgrading to Premium (Cost: 100 Crowns)")}
                        className="mt-3 w-full py-2 bg-yellow-600 text-white font-semibold rounded-lg hover:bg-yellow-500 transition-colors"
                    >
                        Go Premium!
                    </button>
                </div>
            </div>
        </Modal>
    );

    const HistoryModal = () => {
        const favoriteChats = history.filter(c => c.isFavorite);
        const latestChats = history.slice(0, 10);

        const handleDelete = async (chatId) => {
            if (!db || !userId) return;
            try {
                const chatRef = doc(getHistoryCollectionRef(db, userId), chatId);
                await deleteDoc(chatRef);
            } catch (e) {
                console.error("Error deleting chat:", e);
            }
        };

        const ChatItem = ({ chat }) => (
            <div className="p-3 bg-gray-800 rounded-lg flex justify-between items-start border border-gray-700">
                <div className="flex-1 min-w-0">
                    <p className="text-xs text-gray-400 mb-1 flex items-center space-x-1">
                        <Clock className="w-3 h-3" />
                        <span>{new Date(chat.timestamp).toLocaleTimeString()} - {MODES[chat.mode]?.name || chat.mode}</span>
                    </p>
                    <p className="font-semibold text-white truncate">{chat.user}</p>
                    {chat.isImage && <img src={chat.imageUrl} alt="Generated Art" className="w-16 h-16 object-cover rounded mt-2" />}
                </div>
                <div className="ml-4 flex space-x-2">
                    <button onClick={() => toggleFavorite(chat.id)} className={`p-1 rounded-full transition-colors ${chat.isFavorite ? 'text-red-400 fill-red-400' : 'text-gray-400 hover:text-red-400'}`} title="Favorite">
                        <Star className="w-4 h-4" fill={chat.isFavorite ? 'currentColor' : 'none'} />
                    </button>
                    <button onClick={() => { setChats([chat]); setShowHistory(false); setActiveTab(chat.isImage ? 'Images' : 'Text'); }} className="text-gray-400 hover:text-blue-400 p-1 rounded-full transition-colors" title="Load Chat">
                        <BookOpen className="w-4 h-4" />
                    </button>
                    <button onClick={() => handleDelete(chat.id)} className="text-gray-400 hover:text-red-600 p-1 rounded-full transition-colors" title="Delete">
                        <X className="w-4 h-4" />
                    </button>
                </div>
            </div>
        );

        return (
            <Modal title="History & Favorites" onClose={() => setShowHistory(false)}>
                <p className="text-sm text-gray-400 mb-4">Your User ID: <code className="text-yellow-400 select-all">{userId || 'Loading...'}</code></p>
                <div className="space-y-6">
                    <h3 className="text-lg font-semibold text-yellow-400 border-b border-gray-700 pb-2">Favorites ({favoriteChats.length})</h3>
                    <div className="space-y-3 max-h-48 overflow-y-auto pr-2">
                        {favoriteChats.length > 0 ? favoriteChats.map(chat => <ChatItem key={chat.id} chat={chat} />) : <p className="text-gray-500 text-sm">No favorites saved yet.</p>}
                    </div>

                    <h3 className="text-lg font-semibold text-yellow-400 border-b border-gray-700 pb-2">Recent History ({latestChats.length})</h3>
                    <div className="space-y-3 max-h-64 overflow-y-auto pr-2">
                        {latestChats.map(chat => <ChatItem key={chat.id} chat={chat} />)}
                    </div>
                </div>
            </Modal>
        );
    };

    const Modal = ({ title, onClose, children }) => (
        <div className="fixed inset-0 z-50 bg-black bg-opacity-70 flex items-center justify-center p-4">
            <div className="w-full max-w-md bg-gray-800 rounded-xl shadow-2xl transition-all overflow-y-auto max-h-[90vh]">
                <div className="flex justify-between items-center p-4 border-b border-gray-700">
                    <h2 className="text-xl font-bold text-white">{title}</h2>
                    <button onClick={onClose} className="p-2 text-gray-400 hover:text-white rounded-full transition-colors">
                        <X className="w-5 h-5" />
                    </button>
                </div>
                <div className="p-4">
                    {children}
                </div>
            </div>
        </div>
    );

    const DailyChallengeCard = () => {
        if (!dailyChallenge || dailyChallenge.completed) return null;

        return (
            <div className="p-4 bg-gray-800 border-t border-purple-600 text-white">
                <div className="flex justify-between items-center mb-2">
                    <h4 className="text-sm font-bold text-purple-400 flex items-center">
                        <Clock className="w-4 h-4 mr-1" /> Daily Challenge
                    </h4>
                    <span className="text-xs font-semibold flex items-center text-yellow-400">
                        +{dailyChallenge.reward} <Crown className="w-3 h-3 ml-1 fill-yellow-400" />
                    </span>
                </div>
                <p className="text-sm text-gray-300 italic">{dailyChallenge.prompt}</p>
                <button
                    onClick={() => setDailyChallenge(prev => ({ ...prev, completed: true }))} // Mock completion
                    className="mt-3 w-full py-1.5 text-sm bg-purple-600 rounded-lg hover:bg-purple-500 transition-colors font-semibold"
                >
                    Complete & Claim Reward
                </button>
            </div>
        );
    };

    // --- MAIN RENDER ---
    return (
        <div className="h-screen flex flex-col bg-gray-900 font-sans">
            <Header />
            <ModeSwitch />
            <TabBar />
            <DailyChallengeCard />
            <div className="flex-1 overflow-hidden">
                <ChatInterface />
            </div>

            {showSettings && <SettingsModal />}
            {showHistory && <HistoryModal />}
        </div>
    );
};

export default App;



I hope aip code is added already
