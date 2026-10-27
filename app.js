const form = document.getElementById('qr-form');
const input = document.getElementById('qr-input');
const result = document.getElementById('qr-result');
const image = document.getElementById('qr-image');
const downloadLink = document.getElementById('download-link');
const message = document.getElementById('form-message');
document.getElementById('clear-btn').addEventListener('click', () => {
  input.value = '';
  result.hidden = true;
  message.textContent = '';
  input.focus();
});
form.addEventListener('submit', (event) => {
  event.preventDefault();
  const value = input.value.trim();
  if (!value) {
    message.textContent = 'Please enter a website address or text.';
    return;
  }
  // This starter uses a third-party QR image endpoint. Do not enter confidential data.
  const url = 'https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=' + encodeURIComponent(value);
  image.src = url;
  downloadLink.href = url;
  result.hidden = false;
  message.textContent = 'QR image requested. Check the preview below.';
  image.onerror = () => {
    message.textContent = 'Could not load the QR image. Check your internet connection and try again.';
    result.hidden = true;
  };
  image.onload = () => {
    message.textContent = 'Your QR code is ready.';
  };
});