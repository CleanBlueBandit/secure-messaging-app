// End-to-end encryption module using Web Crypto API
// Uses RSA-OAEP for key exchange and AES-GCM for message encryption

const CryptoModule = (function() {
  const DB_NAME = 'securechat-keys';
  const STORE_KEYPAIRS = 'keypairs';
  const STORE_SENT = 'sent_messages'; // new store for sent message plaintext

  // Open IndexedDB (version 2 adds the sent_messages store)
  function openDB() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 2); // bumped version

      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);

      request.onupgradeneeded = (event) => {
        const db = event.target.result;
        // Create keypair store if not present (from version 1)
        if (!db.objectStoreNames.contains(STORE_KEYPAIRS)) {
          db.createObjectStore(STORE_KEYPAIRS, { keyPath: 'id' });
        }
        // Create sent messages store (new in version 2)
        if (!db.objectStoreNames.contains(STORE_SENT)) {
          db.createObjectStore(STORE_SENT, { keyPath: 'messageId' });
        }
      };
    });
  }

  // Generate RSA key pair for user
  async function generateKeyPair() {
    const keyPair = await window.crypto.subtle.generateKey(
      {
        name: 'RSA-OAEP',
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: 'SHA-256'
      },
      true, // extractable
      ['encrypt', 'decrypt']
    );
    return keyPair;
  }

  // Export public key to base64 string
  async function exportPublicKey(publicKey) {
    const exported = await window.crypto.subtle.exportKey('spki', publicKey);
    return arrayBufferToBase64(exported);
  }

  // Import public key from base64 string
  async function importPublicKey(base64Key) {
    const keyData = base64ToArrayBuffer(base64Key);
    return await window.crypto.subtle.importKey(
      'spki',
      keyData,
      { name: 'RSA-OAEP', hash: 'SHA-256' },
      false,
      ['encrypt']
    );
  }

  // Export private key to JWK for storage
  async function exportPrivateKey(privateKey) {
    return await window.crypto.subtle.exportKey('jwk', privateKey);
  }

  // Import private key from JWK
  async function importPrivateKey(jwk) {
    return await window.crypto.subtle.importKey(
      'jwk',
      jwk,
      { name: 'RSA-OAEP', hash: 'SHA-256' },
      false,
      ['decrypt']
    );
  }

  // Generate AES key for message encryption
  async function generateAESKey() {
    return await window.crypto.subtle.generateKey(
      { name: 'AES-GCM', length: 256 },
      true,
      ['encrypt', 'decrypt']
    );
  }

  // Encrypt message with AES-GCM
  async function encryptMessage(message, aesKey) {
    const encoder = new TextEncoder();
    const data = encoder.encode(message);
    const iv = window.crypto.getRandomValues(new Uint8Array(12));

    const encrypted = await window.crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: iv },
      aesKey,
      data
    );

    return {
      encryptedContent: arrayBufferToBase64(encrypted),
      iv: arrayBufferToBase64(iv)
    };
  }

  // Decrypt message with AES-GCM
  async function decryptMessage(encryptedContent, iv, aesKey) {
    const encryptedData = base64ToArrayBuffer(encryptedContent);
    const ivData = base64ToArrayBuffer(iv);

    const decrypted = await window.crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: ivData },
      aesKey,
      encryptedData
    );

    const decoder = new TextDecoder();
    return decoder.decode(decrypted);
  }

  // Encrypt AES key with recipient's public key
  async function encryptAESKey(aesKey, recipientPublicKey) {
    const exportedAESKey = await window.crypto.subtle.exportKey('raw', aesKey);

    const encrypted = await window.crypto.subtle.encrypt(
      { name: 'RSA-OAEP', hash: 'SHA-256' },
      recipientPublicKey,
      exportedAESKey
    );

    return arrayBufferToBase64(encrypted);
  }

  // Decrypt AES key with own private key (only for received messages)
  async function decryptAESKey(encryptedKey, privateKey) {
    try {
      const encryptedData = base64ToArrayBuffer(encryptedKey);

      const decrypted = await window.crypto.subtle.decrypt(
        { name: 'RSA-OAEP', hash: 'SHA-256' },
        privateKey,
        encryptedData
      );

      return await window.crypto.subtle.importKey(
        'raw',
        decrypted,
        { name: 'AES-GCM', length: 256 },
        false,
        ['decrypt']
      );
    } catch (error) {
      console.error('decryptAESKey error details:', {
        errorMessage: error.message,
        errorName: error.name,
        keyType: privateKey?.type,
        keyAlgorithm: privateKey?.algorithm?.name
      });
      throw new Error(`Failed to decrypt AES key: ${error.message}`);
    }
  }

  // Store key pair in IndexedDB
  async function storeKeyPair(userId, privateKeyJWK) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction([STORE_KEYPAIRS], 'readwrite');
      const store = transaction.objectStore(STORE_KEYPAIRS);
      const request = store.put({ id: userId, privateKey: privateKeyJWK });

      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  // Get private key from IndexedDB
  async function getStoredPrivateKey(userId) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction([STORE_KEYPAIRS], 'readonly');
      const store = transaction.objectStore(STORE_KEYPAIRS);
      const request = store.get(userId);

      request.onsuccess = () => {
        if (request.result) {
          resolve(request.result.privateKey);
        } else {
          resolve(null);
        }
      };
      request.onerror = () => reject(request.error);
    });
  }

  // Delete stored keys
  async function deleteStoredKeys(userId) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction([STORE_KEYPAIRS], 'readwrite');
      const store = transaction.objectStore(STORE_KEYPAIRS);
      const request = store.delete(userId);

      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  // ---------- New: Cache for sent message plaintext ----------
  async function storeSentPlaintext(messageId, plaintext) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction([STORE_SENT], 'readwrite');
      const store = tx.objectStore(STORE_SENT);
      const req = store.put({ messageId, plaintext });
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }

  async function getSentPlaintext(messageId) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction([STORE_SENT], 'readonly');
      const store = tx.objectStore(STORE_SENT);
      const req = store.get(messageId);
      req.onsuccess = () => resolve(req.result?.plaintext || null);
      req.onerror = () => reject(req.error);
    });
  }
  // ------------------------------------------------------------

  // Utility: ArrayBuffer to Base64
  function arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }

  // Utility: Base64 to ArrayBuffer
  function base64ToArrayBuffer(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes.buffer;
  }

  // Public API
  return {
    generateKeyPair,
    exportPublicKey,
    importPublicKey,
    exportPrivateKey,
    importPrivateKey,
    generateAESKey,
    encryptMessage,
    decryptMessage,
    encryptAESKey,
    decryptAESKey,
    storeKeyPair,
    getStoredPrivateKey,
    deleteStoredKeys,
    storeSentPlaintext,      // newly exposed
    getSentPlaintext,        // newly exposed

    // High-level encrypt function for sending messages
    async encryptForRecipient(message, recipientPublicKeyBase64) {
      const recipientPublicKey = await importPublicKey(recipientPublicKeyBase64);
      const aesKey = await generateAESKey();
      const { encryptedContent, iv } = await encryptMessage(message, aesKey);
      const encryptedKey = await encryptAESKey(aesKey, recipientPublicKey);

      return {
        encryptedContent,
        encryptedKey,
        iv
      };
    },

    // High-level decrypt function for receiving messages
    async decryptWithPrivateKey(encryptedContent, encryptedKey, iv, privateKey) {
      const aesKey = await decryptAESKey(encryptedKey, privateKey);
      return await decryptMessage(encryptedContent, iv, aesKey);
    }
  };
})();

// Make available globally
window.CryptoModule = CryptoModule;
