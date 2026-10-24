// File names supply a fallback only when the source omits a useful MIME type.
// Never turn an explicit server MIME into a different execution context.
const extensions = {
    txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', json: 'application/json',
    pdf: 'application/pdf', doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', heic: 'image/heic',
    mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', mkv: 'video/x-matroska',
    mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav', ogg: 'audio/ogg',
};
export function effectiveMime(name, mime) {
    // Content-Type may include parameters or mixed case, but Android choosers and
    // media elements need the bare media type. A generic type carries no useful
    // format information, so only then use the file extension as a fallback.
    const type = mime?.split(';', 1)[0]?.trim().toLowerCase() || '';
    if (type && type !== 'application/octet-stream' && type !== 'binary/octet-stream' && type !== 'application/x-octet-stream')
        return type;
    const ext = name.split('.').pop()?.toLowerCase() || '';
    return extensions[ext] || 'application/octet-stream';
}
export function effectiveKind(name, mime) {
    const head = effectiveMime(name, mime).split('/')[0];
    return head === 'image' || head === 'video' || head === 'audio' ? head : 'file';
}
