// End-to-end encryption module using Web Crypto API
// Uses RSA-OAEP for key exchange and AES-GCM for message encryption

const CryptoModule = (function() {
  const DB_NAME = 'securechat-keys';
  const STORE_NAME = 'keypairs';

  // Open IndexedDB
  function openDB() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 1);
      
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
      
      request.onupgradeneeded = (event) => {
        const db = event.target.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: 'id' });
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
      {
        name: 'RSA-OAEP',
        hash: 'SHA-256'
      },
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
      {
        name: 'RSA-OAEP',
        hash: 'SHA-256'
      },
      false,
      ['decrypt']
    );
  }

  // Generate AES key for message encryption
  async function generateAESKey() {
    return await window.crypto.subtle.generateKey(
      {
        name: 'AES-GCM',
        length: 256
      },
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
      {
        name: 'AES-GCM',
        iv: iv
      },
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
      {
        name: 'AES-GCM',
        iv: ivData
      },
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
      {
        name: 'RSA-OAEP'
      },
      recipientPublicKey,
      exportedAESKey
    );

    return arrayBufferToBase64(encrypted);
  }

  // Decrypt AES key with own private key
  async function decryptAESKey(encryptedKey, privateKey) {
    const encryptedData = base64ToArrayBuffer(encryptedKey);
    
    const decrypted = await window.crypto.subtle.decrypt(
      {
        name: 'RSA-OAEP'
      },
      privateKey,
      encryptedData
    );

    return await window.crypto.subtle.importKey(
      'raw',
      decrypted,
      {
        name: 'AES-GCM',
        length: 256
      },
      false,
      ['decrypt']
    );
  }

  // Store key pair in IndexedDB
  async function storeKeyPair(userId, privateKeyJWK) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction([STORE_NAME], 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
      const request = store.put({ id: userId, privateKey: privateKeyJWK });
      
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  // Get private key from IndexedDB
  async function getStoredPrivateKey(userId) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction([STORE_NAME], 'readonly');
      const store = transaction.objectStore(STORE_NAME);
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
      const transaction = db.transaction([STORE_NAME], 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
      const request = store.delete(userId);
      
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

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
