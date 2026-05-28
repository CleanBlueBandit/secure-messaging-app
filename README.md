# Secure Messaging Application

An end-to-end encrypted messaging application built with the Web Crypto API.

## Encryption

Messages are secured using a hybrid encryption scheme:

- **Message Encryption**: AES-256-GCM provides authenticated encryption for message content with a unique 96-bit initialization vector per message
- **Key Exchange**: RSA-OAEP (2048-bit) with SHA-256 encrypts the per-message AES keys for secure transmission between users

### How It Works

1. Each user generates a 2048-bit RSA key pair on registration
2. Public keys are stored on the server; private keys remain only on the user's device in IndexedDB
3. When sending a message, a random AES-256 key is generated to encrypt the content
4. The AES key is then encrypted with the recipient's RSA public key
5. Only the recipient's private key can decrypt the AES key and read the message

Messages cannot be read by the server, as private keys never leave the user's device.
