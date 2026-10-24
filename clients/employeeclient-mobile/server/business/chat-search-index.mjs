// A derived substring index. Messages remain authoritative; authorization,
// literal matching, hides and recalls are always checked by the final query.
export function installChatSearchIndex(db) {
 const exists=!!db.prepare("SELECT 1 FROM sqlite_master WHERE name='message_search_index'").get();
 db.exec('BEGIN IMMEDIATE');
 try {
  db.exec(`
   CREATE INDEX IF NOT EXISTS messages_conversation_order ON messages(message_type,seq);
   CREATE INDEX IF NOT EXISTS messages_author_order ON messages(message_type,actor_id,seq);
   CREATE INDEX IF NOT EXISTS messages_conversation_date ON messages(message_type,created_at,seq);
   CREATE INDEX IF NOT EXISTS messages_reply ON messages(reply_id);
   CREATE VIRTUAL TABLE IF NOT EXISTS message_search_index USING fts5(body,filenames,tokenize='trigram case_sensitive 1');
   CREATE TRIGGER IF NOT EXISTS message_search_insert AFTER INSERT ON messages BEGIN
    INSERT INTO message_search_index(rowid,body,filenames) VALUES(new.seq,lower(new.body),
     (SELECT group_concat(lower(json_extract(value,'$.name')),char(10)) FROM json_each(new.attachments_json)));
   END;
   CREATE TRIGGER IF NOT EXISTS message_search_update AFTER UPDATE OF body,attachments_json ON messages BEGIN
    DELETE FROM message_search_index WHERE rowid=old.seq;
    INSERT INTO message_search_index(rowid,body,filenames) VALUES(new.seq,lower(new.body),
     (SELECT group_concat(lower(json_extract(value,'$.name')),char(10)) FROM json_each(new.attachments_json)));
   END;
   CREATE TRIGGER IF NOT EXISTS message_search_delete AFTER DELETE ON messages BEGIN
    DELETE FROM message_search_index WHERE rowid=old.seq;
   END;
  `);
  if(!exists)db.exec(`INSERT INTO message_search_index(rowid,body,filenames)
   SELECT seq,lower(body),(SELECT group_concat(lower(json_extract(value,'$.name')),char(10)) FROM json_each(attachments_json)) FROM messages`);
  db.exec('COMMIT');
 } catch(e) {db.exec('ROLLBACK');throw e;}
}

export function searchIndexTerm(db,query) {
 // SQLite lower() folds ASCII, unlike JS Unicode lowercasing. Keep exactly the
 // existing literal-search semantics, including CJK, punctuation and accents.
 const lower=db.prepare('SELECT lower(?) text').get(query).text;
 const chars=[...lower];
 if(chars.length<3||lower.includes('\0'))return null;
 return '"'+lower.replaceAll('"','""')+'"';
}
