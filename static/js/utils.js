// utils.js - Utility functions

export function openOptionsDialog(dialog) {
    document.querySelectorAll('dialog.options-dialog[open]').forEach(open => {
        if (open !== dialog) open.close();
    });
    if (!dialog.open) dialog.show();
}

/**
 * Extracts the YouTube video ID from a URL
 * @param {string} url - The YouTube URL
 * @returns {string|null} - The video ID or null if not found
 */
export function extractVideoId(url) {
    const pattern = /(?:v=|\/)([0-9A-Za-z_-]{11})/;
    const match = url.match(pattern);
    return match ? match[1] : null;
}

/**
 * Formats seconds into MM:SS, or H:MM:SS from one hour onward.
 * @param {number} seconds - The time in seconds
 * @returns {string} - Formatted time string
 */
export function formatTime(seconds) {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor(seconds / 60) % 60;
    const secs = Math.floor(seconds % 60);
    const clock = `${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    return hours ? `${hours}:${clock}` : clock;
}

export function formatTimestamp(timestamp) {
    const value = String(timestamp);
    const seconds = value.split(':').reduce((total, part) => total * 60 + Number(part), 0);
    const fraction = value.match(/\.\d+$/)?.[0] || '';
    return formatTime(Math.floor(seconds)) + fraction;
}

/**
 * Sends a generated file through one browser download flow.
 * Browser download settings control whether to prompt for a location.
 */
export function datedExportFilename(filename, date = new Date()) {
    const dot = filename.lastIndexOf('.');
    const stem = dot > 0 ? filename.slice(0, dot) : filename;
    const extension = dot > 0 ? filename.slice(dot) : '';
    if (/_\d{4}-\d{2}-\d{2}$/.test(stem)) return filename;
    const day = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    return `${stem}_${day}${extension}`;
}

export async function saveBlobToUserLocation(blob, filename, container = document.body) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = datedExportFilename(filename);
    link.style.display = 'none';
    container.appendChild(link);
    try {
        link.click();
    } finally {
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 60000);
    }
}