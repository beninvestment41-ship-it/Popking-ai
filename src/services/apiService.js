src/services/apiService.js
 *
 * This service handles all interactions with the Gemini and Imagen APIs.
 * It abstracts away the API key handling, request structuring, and response parsing.
 *
 * NOTE: When deploying, replace the placeholder API_KEY with a secure environment variable.
 */

// Placeholder for the API Key. Must be set securely in a real application.
const API_KEY = "";

// Base URL for the non-image models (gemini-2.5-flash-preview-09-2025)
const BASE_URL_GEMINI_FLASH =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-09-2025:generateContent";

// Base URL for the image generation model (imagen-4.0-generate-001)
const BASE_URL_IMAGEN =
  "https://generativelanguage.googleapis.com/v1beta/models/imagen-4.0-generate-001:predict";

// Base URL for the TTS model (gemini-2.5-flash-preview-tts)
const BASE_URL_TTS =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-tts:generateContent";


/**
 * Converts a base64 string to an ArrayBuffer. Needed for processing PCM audio.
 * @param {string} base64 - The base64 string.
 * @returns {ArrayBuffer}
 */
const base64ToArrayBuffer = (base64) => {
  const binaryString = atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes.buffer;
};

/**
 * Converts signed 16-bit PCM data to a WAV Blob.
 * @param {Int16Array} pcm16 - PCM audio data.
 * @param {number} sampleRate - The audio sample rate.
 * @returns {Blob} - A Blob containing the WAV file.
 */
const pcmToWav = (pcm16, sampleRate) => {
  const numChannels = 1;
  const bytesPerSample = 2;
  const blockAlign = numChannels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;

  const buffer = new ArrayBuffer(44 + pcm16.byteLength);
  const view = new DataView(buffer);

  // RIFF identifier
  writeString(view, 0, 'RIFF');
  // RIFF chunk length
  view.setUint32(4, 36 + pcm16.byteLength, true);
  // RIFF type
  writeString(view, 8, 'WAVE');
  // format chunk identifier
  writeString(view, 12, 'fmt ');
  // format chunk length
  view.setUint32(16, 16, true);
  // sample format (1 = PCM)
  view.setUint16(20, 1, true);
  // number of channels
  view.setUint16(22, numChannels, true);
  // sample rate
  view.setUint32(24, sampleRate, true);
  // byte rate (sample rate * block align)
  view.setUint32(28, byteRate, true);
  // block align (num channels * bytes per sample)
  view.setUint16(32, blockAlign, true);
  // bits per sample
  view.setUint16(34, 16, true);
  // data chunk identifier
  writeString(view, 36, 'data');
  // data chunk length
  view.setUint32(40, pcm16.byteLength, true);

  // Write PCM data
  let offset = 44;
  for (let i = 0; i < pcm16.length; i++) {
    view.setInt16(offset, pcm16[i], true);
    offset += 2;
  }

  return new Blob([buffer], { type: 'audio/wav' });

  function writeString(view, offset, string) {
    for (let i = 0; i < string.length; i++) {
      view.setUint8(offset + i, string.charCodeAt(i));
    }
  }
};


/**
 * Generic fetch wrapper with exponential backoff.
 * @param {string} url - The API URL.
 * @param {object} options - Fetch options (method, headers, body).
 * @param {number} retries - Current retry count.
 * @returns {Promise<object>} - JSON response object.
 */
const fetchWithRetry = async (url, options, retries = 0) => {
  const maxRetries = 3;
  try {
    const response = await fetch(url, options);
    if (!response.ok) {
      if (response.status === 429 && retries < maxRetries) {
        const delay = Math.pow(2, retries) * 1000 + Math.random() * 1000;
        await new Promise(resolve => setTimeout(resolve, delay));
        return fetchWithRetry(url, options, retries + 1);
      }
      const errorText = await response.text();
      throw new Error(`API Request failed with status ${response.status}: ${errorText}`);
    }
    return response.json();
  } catch (error) {
    if (retries < maxRetries) {
      const delay = Math.pow(2, retries) * 1000 + Math.random() * 1000;
      await new Promise(resolve => setTimeout(resolve, delay));
      return fetchWithRetry(url, options, retries + 1);
    }
    throw error;
  }
};

/**
 * Generates text content (chat, summarization, code explanation).
 * Can optionally include Google Search grounding via the `useGrounding` flag.
 * @param {string} userQuery - The user's prompt.
 * @param {string} systemInstruction - The AI persona and mode context.
 * @param {boolean} useGrounding - If true, enables Google Search grounding.
 * @returns {Promise<{text: string, sources: Array<{uri: string, title: string}>}>}
 */
export const generateTextContent = async (userQuery, systemInstruction, useGrounding = false) => {
  const apiUrl = `${BASE_URL_GEMINI_FLASH}?key=${API_KEY}`;
  
  const payload = {
    contents: [{ parts: [{ text: userQuery }] }],
    systemInstruction: {
      parts: [{ text: systemInstruction }]
    },
    tools: useGrounding ? [{ google_search: {} }] : undefined,
  };

  const options = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  };

  const result = await fetchWithRetry(apiUrl, options);
  const candidate = result.candidates?.[0];

  if (candidate && candidate.content?.parts?.[0]?.text) {
    const text = candidate.content.parts[0].text;
    let sources = [];

    // Extract grounding sources if used
    const groundingMetadata = candidate.groundingMetadata;
    if (groundingMetadata && groundingMetadata.groundingAttributions) {
      sources = groundingMetadata.groundingAttributions
        .map(attribution => ({
          uri: attribution.web?.uri,
          title: attribution.web?.title,
        }))
        .filter(source => source.uri && source.title);
    }
    return { text, sources };
  } else {
    console.error("Gemini text generation failed:", result);
    return { text: "Error: Could not generate a response. Please check the API status.", sources: [] };
  }
};

/**
 * Generates structured data (e.g., flashcards, quizzes).
 * @param {string} userQuery - The user's request for study material.
 * @param {string} systemInstruction - The AI persona and mode context.
 * @returns {Promise<object>} - Parsed JSON object containing the structured data.
 */
export const generateStructuredStudyContent = async (userQuery, systemInstruction) => {
  const apiUrl = `${BASE_URL_GEMINI_FLASH}?key=${API_KEY}`;

  const payload = {
    contents: [{ parts: [{ text: userQuery }] }],
    systemInstruction: {
      parts: [{ text: systemInstruction }]
    },
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: {
        type: "ARRAY",
        description: "A list of structured study items (flashcards or quiz questions).",
        items: {
          type: "OBJECT",
          properties: {
            type: { type: "STRING", enum: ["flashcard", "quiz"] },
            question: { type: "STRING" },
            answer: { type: "STRING" }, // Or correct answer for quiz
            options: { 
              type: "ARRAY",
              items: { type: "STRING" },
              description: "Only used for quiz type. Contains 3 incorrect options and 1 correct one (which is the 'answer' field)."
            }
          },
          required: ["type", "question", "answer"]
        }
      }
    }
  };

  const options = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  };

  const result = await fetchWithRetry(apiUrl, options);
  
  try {
    const jsonString = result.candidates?.[0]?.content?.parts?.[0]?.text;
    if (jsonString) {
      return JSON.parse(jsonString);
    } else {
      throw new Error("Received empty or malformed JSON string.");
    }
  } catch (e) {
    console.error("Gemini structured generation failed:", e, result);
    return [{ type: "error", question: "Error generating study material.", answer: "Please try again with a clearer prompt." }];
  }
};


/**
 * Generates an image based on a prompt using Imagen 4.0.
 * @param {string} prompt - The creative text prompt for the image.
 * @returns {Promise<string>} - Base64 image data URL or null on failure.
 */
export const generateImageContent = async (prompt) => {
  const apiUrl = `${BASE_URL_IMAGEN}?key=${API_KEY}`;

  const payload = {
    instances: [{ prompt: prompt }],
    parameters: { "sampleCount": 1 }
  };

  const options = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  };

  const result = await fetchWithRetry(apiUrl, options);
  
  if (result.predictions && result.predictions.length > 0 && result.predictions[0].bytesBase64Encoded) {
    return `data:image/png;base64,${result.predictions[0].bytesBase64Encoded}`;
  } else {
    console.error("Imagen generation failed:", result);
    return null;
  }
};


/**
 * Generates speech audio from text using TTS model.
 * @param {string} text - The text to synthesize.
 * @param {string} voiceName - The desired voice (e.g., 'Kore', 'Puck').
 * @returns {Promise<string>} - A blob URL for the WAV audio, or null on failure.
 */
export const generateTTSAudio = async (text, voiceName = "Kore") => {
  const apiUrl = `${BASE_URL_TTS}?key=${API_KEY}`;

  // Simple prompt to control style, tone, or accent
  const ttsPrompt = `Say clearly: "${text}"`;

  const payload = {
    contents: [{ parts: [{ text: ttsPrompt }] }],
    generationConfig: {
      responseModalities: ["AUDIO"],
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: { voiceName: voiceName }
        }
      }
    },
    model: "gemini-2.5-flash-preview-tts"
  };

  const options = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  };

  const result = await fetchWithRetry(apiUrl, options);
  const part = result?.candidates?.[0]?.content?.parts?.[0];
  const audioData = part?.inlineData?.data;
  const mimeType = part?.inlineData?.mimeType;

  if (audioData && mimeType && mimeType.startsWith("audio/L16")) {
    // Extract sample rate from mimeType: "audio/L16;rate=24000"
    const rateMatch = mimeType.match(/rate=(\d+)/);
    const sampleRate = rateMatch ? parseInt(rateMatch[1], 10) : 24000; 
    
    // 1. Convert Base64 to ArrayBuffer
    const pcmData = base64ToArrayBuffer(audioData);
    
    // 2. Convert to Int16Array (API returns signed PCM16)
    const pcm16 = new Int16Array(pcmData);

    // 3. Convert PCM16 to WAV Blob
    const wavBlob = pcmToWav(pcm16, sampleRate);

    // 4. Create and return a Blob URL
    return URL.createObjectURL(wavBlob);
  } else {
    console.error("TTS generation failed or returned invalid data:", result);
    return null;
  }
};
