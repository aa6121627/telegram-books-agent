import fs from "node:fs/promises";
import path from "node:path";
import {
  sendMessage, sendPhotoFile, editMessageText,
  answerCallbackQuery, telegramApi, editMessageCaption
} from "./bot-api.js";
import {
  claimWebhookUpdate, finishWebhookUpdate, savePendingBook,
  getPendingBook, updatePendingBook, saveBook, markFailed
} from "./firebase.js";
import { withTelegram, getDocumentName, getDocumentSize } from "./telegram.js";
import { extractFirstPageCover } from "./cover.js";
import { uploadToDrive } from "./drive.js";
import { uploadCoverAndGetDirectLink } from "./top4top.js";

const ADMIN = String(process.env.ADMIN_TELEGRAM_ID || "");
const WORK = process.env.WORK_DIR || "/tmp/books-agent";
const GRADE_NAMES = {1:"الأول الثانوي",2:"الثاني الثانوي",3:"الثالث الثانوي"};

function safeName(s) {
  return path.basename(String(s || "book.pdf")).replace(/[\\/:*?"<>|]/g, "_");
}
function normalizeDigits(s) {
  return String(s).replace(/[٠-٩]/g,d=>String("٠١٢٣٤٥٦٧٨٩".indexOf(d))).replace(/[۰-۹]/g,d=>String("۰۱۲۳۴۵۶۷۸۹".indexOf(d)));
}
function normalizedFileName(name) {
  return normalizeDigits(safeName(name).replace(/\.[^.]+$/,""))
    .replace(/[أإآ]/g,"ا")
    .replace(/ى/g,"ي")
    .replace(/[ـ]/g,"")
    .replace(/[_.-]+/g," ")
    .replace(/\s+/g," ")
    .trim()
    .toLowerCase();
}
function detectGrade(name) {
  const s = normalizedFileName(name);
  if (/الثالث\s+الثانوي|الصف\s+الثالث|(?:^|\s)3(?:\s|$)|(?:^|\s)3\s*ث/.test(s)) return 3;
  if (/الثاني\s+الثانوي|الصف\s+الثاني|(?:^|\s)2(?:\s|$)|(?:^|\s)2\s*ث/.test(s)) return 2;
  if (/الاول\s+الثانوي|الصف\s+الاول|(?:^|\s)1(?:\s|$)|(?:^|\s)1\s*ث/.test(s)) return 1;
  return 0;
}
function cleanName(name) {
  const grade = detectGrade(name);
  let s = normalizedFileName(name).replace(/\.[^.]+$/,"");
  // Remove year tokens such as 2027, without touching grade digits.
  s = s.replace(/(?:^|\s)(?:19|20)\d{2}(?=\s|$)/g," ");
  // Remove explicit grade labels and standalone grade number (1, 2 or 3).
  s = s.replace(/الصف\s+(?:الاول|الثاني|الثالث)\s+الثانوي/g," ")
    .replace(/(?:الاول|الثاني|الثالث)\s+الثانوي/g," ")
    .replace(/(?:^|\s)[123]\s*ث(?:انوي)?(?=\s|$)/g," ");
  if (grade) s = s.replace(new RegExp(`(^|\\s)${grade}(?=\\s|$)`,"g")," ");
  // "بكالوريا" is used as a grade descriptor in these uploaded filenames.
  s = s.replace(/\bبكالوريا\b/g," ");
  return s.replace(/\s+/g," ").trim() || "كتاب جديد";
}
function keyboard(id) {
  return { inline_keyboard: [[
    {text:"✅ موافقة ورفع",callback_data:`approve:${id}`},
    {text:"✏️ تعديل البيانات",callback_data:`edit:${id}`},
    {text:"❌ إلغاء",callback_data:`cancel:${id}`}
  ]]};
}
function getDocument(message) {
  if(message.document) return {fileName:message.document.file_name || "book.pdf",size:Number(message.document.file_size||0)};
  if(message.video) return {fileName:message.video.file_name || "book.mp4",size:Number(message.video.file_size||0)};
  return null;
}
async function findMtprotoMessage(client, botUsername, pending) {
  const entity = await client.getEntity(botUsername);
  const expectedId = Number(pending.sourceMessageId);
  const expectedSize = Number(pending.size || 0);
  const expectedName = String(pending.originalName || "").trim();
  const expectedDate = Number(pending.sourceDate || 0);
  const candidates = [];
  let exactMatch = null;

  console.log("[MTProto] lookup:", JSON.stringify({
    accountId: String((await client.getMe()).id || ""),
    bot: botUsername,
    sourceMessageId: expectedId,
    sourceDate: expectedDate,
    fileName: expectedName,
    size: expectedSize
  }));

  for await (const m of client.iterMessages(entity, { limit: 500 })) {
    if (!m.media?.document) continue;
    const name = getDocumentName(m);
    const size = getDocumentSize(m);
    const dateValue = m.date instanceof Date ? Math.floor(m.date.getTime()/1000) : Number(m.date || 0);
    if (Number(m.id) === expectedId) {
      exactMatch = m;
      break;
    }
    if (name === expectedName && size === expectedSize) {
      candidates.push({
        message: m,
        id: Number(m.id),
        name,
        size,
        date: dateValue,
        outgoing: Boolean(m.out)
      });
    }
  }

  if (exactMatch) {
    console.log("[MTProto] exact message id matched:", expectedId);
    return exactMatch;
  }

  const outgoing = candidates.filter(x => x.outgoing);
  const pool = outgoing.length ? outgoing : candidates;
  if (pool.length) {
    pool.sort((a,b) => {
      const da = expectedDate && a.date ? Math.abs(a.date-expectedDate) : 0;
      const db = expectedDate && b.date ? Math.abs(b.date-expectedDate) : 0;
      return da-db || b.id-a.id;
    });
    const best = pool[0];
    const second = pool[1];
    const bestDistance = expectedDate && best.date ? Math.abs(best.date-expectedDate) : null;
    const secondDistance = second && expectedDate && second.date ? Math.abs(second.date-expectedDate) : null;
    console.log("[MTProto] candidates:", JSON.stringify(pool.map(x => ({
      id:x.id, date:x.date, outgoing:x.outgoing, name:x.name, size:x.size
    }))));
    if (!second || bestDistance === null || secondDistance === null || bestDistance < secondDistance) {
      console.log("[MTProto] selected matching upload:", best.id);
      return best.message;
    }
  }

  throw new Error(
    `تعذر تحديد رسالة الملف بشكل آمن في محادثة البوت. رقم Bot API: ${expectedId}، تاريخ الإرسال: ${expectedDate}، الملفات المطابقة: ${JSON.stringify(candidates.map(x=>({id:x.id,date:x.date,outgoing:x.outgoing}))) }.`
  );
}
async function downloadSource(client, pending, dest) {
  const bot=process.env.BOT_USERNAME;
  if(!bot) throw new Error("Missing BOT_USERNAME secret (username without @).");
  const m=await findMtprotoMessage(client,bot,pending);
  const size=getDocumentSize(m);
  const max=Number(process.env.MAX_BOOK_MB||8000)*1024*1024;
  if(!size || size>max) throw new Error("حجم الملف غير معروف أو يتجاوز MAX_BOOK_MB.");
  await fs.mkdir(path.dirname(dest),{recursive:true});
  await client.downloadMedia(m,{outputFile:dest,progressCallback:(done,total)=>{
    if(total) console.log(`Download ${Math.floor(done*100/total)}%`);
  }});
  const st=await fs.stat(dest);
  if(!st.size) throw new Error("الملف الذي تم تنزيله فارغ.");
  return {message:m,size:st.size};
}
async function receiveDocument(message) {
  const chatId=message.chat.id, userId=String(message.from?.id||"");
  if(userId!==ADMIN) return;
  const doc=getDocument(message);
  if(!doc) return;
  if(doc.size && doc.size>Number(process.env.MAX_BOOK_MB||8000)*1024*1024) {
    await sendMessage(chatId,"حجم الملف أكبر من الحد المحدد في إعدادات البوت."); return;
  }
  const grade=detectGrade(doc.fileName);
  const id=String(message.message_id);
  await savePendingBook(id,{
    chatId, sourceMessageId:message.message_id, sourceChatId:chatId,
    originalName:doc.fileName, size:doc.size, sourceDate:Number(message.date||0), book_name:cleanName(doc.fileName),
    book_type:grade, status:"preparing"
  });
  await sendMessage(chatId,"وصل الكتاب. جارٍ تجهيز المعاينة واستخراج الغلاف...");
}
async function preparePreview(message) {
  const id=String(message.message_id), pending=await getPendingBook(id);
  if(!pending || pending.status!=="preparing") return;
  const bookPath=path.join(WORK,`${id}-${safeName(pending.originalName)}`);
  const coverPath=path.join(WORK,`${id}-cover.jpg`);
  try {
    await withTelegram(async client=>{
      await downloadSource(client,pending,bookPath);
      await extractFirstPageCover(bookPath,coverPath);
    });
    const grade=pending.book_type;
    const caption=[
      "📚 معاينة كتاب جديد",
      `الاسم: ${pending.book_name || "غير محدد"}`,
      `الصف: ${grade ? GRADE_NAMES[grade] : "غير محدد"}`,
      `الملف: ${pending.originalName}`,
      `الحجم: ${(Number(pending.size||0)/1048576).toFixed(1)} MB`,
      "",
      "لن يتم رفع الكتاب إلى Drive أو Top4Top أو Firebase قبل موافقتك."
    ].join("\n");
    const photo=await sendPhotoFile(pending.chatId,coverPath,caption,{reply_markup:keyboard(id)});
    await updatePendingBook(id,{status:"awaiting_approval",previewMessageId:photo.message_id,coverPrepared:true});
  } catch(e) {
    await updatePendingBook(id,{status:"failed",error:String(e).slice(0,800)});
    await sendMessage(pending.chatId,`تعذر تجهيز المعاينة: ${String(e).slice(0,700)}`);
  } finally {
    await fs.rm(bookPath,{force:true}).catch(()=>{});
    await fs.rm(coverPath,{force:true}).catch(()=>{});
  }
}
async function finishApproval(id, query) {
  const pending=await getPendingBook(id);
  if(!pending || pending.status!=="awaiting_approval") throw new Error("هذا الطلب غير متاح للموافقة أو تمت معالجته.");
  await updatePendingBook(id,{status:"uploading"});
  const bookPath=path.join(WORK,`${id}-${safeName(pending.originalName)}`);
  const coverPath=path.join(WORK,`${id}-cover.jpg`);
  try {
    await fs.mkdir(WORK,{recursive:true});
    await withTelegram(async client=>{
      await downloadSource(client,pending,bookPath);
      await extractFirstPageCover(bookPath,coverPath);
      const drive=await uploadToDrive(bookPath,safeName(pending.originalName),"application/octet-stream");
      const imageUrl=await uploadCoverAndGetDirectLink(client,coverPath);
      await saveBook(id,{
        book_img:imageUrl,
        book_name:pending.book_name,
        book_type:Number(pending.book_type),
        book_url:`https://drive.google.com/uc?export=download&id=${drive.id}`
      });
    });
    await updatePendingBook(id,{status:"completed",completedAt:Date.now()});
    await editMessageCaption(pending.chatId,pending.previewMessageId,"✅ تم اعتماد الكتاب ورفعه بنجاح.");
    await answerCallbackQuery(query.id,"تم الرفع بنجاح");
  } catch(e) {
    await updatePendingBook(id,{status:"failed",error:String(e).slice(0,900)});
    await markFailed(id,e);
    await answerCallbackQuery(query.id,"فشل الرفع؛ راجع رسالة الحالة.",true);
    await sendMessage(pending.chatId,`فشل رفع الكتاب: ${String(e).slice(0,700)}`);
  } finally {
    await fs.rm(bookPath,{force:true}).catch(()=>{});
    await fs.rm(coverPath,{force:true}).catch(()=>{});
  }
}
async function handleCallback(q) {
  if(String(q.from?.id||"")!==ADMIN) {
    await answerCallbackQuery(q.id,"غير مصرح لك باستخدام هذا البوت.",true); return;
  }
  const [action,id]=String(q.data||"").split(":");
  const p=await getPendingBook(id);
  if(!p) { await answerCallbackQuery(q.id,"الطلب غير موجود.",true); return; }
  if(action==="approve") return finishApproval(id,q);
  if(action==="cancel") {
    await updatePendingBook(id,{status:"cancelled",cancelledAt:Date.now()});
    await editMessageText(p.chatId,p.previewMessageId,"تم إلغاء الطلب.");
    await answerCallbackQuery(q.id,"تم الإلغاء"); return;
  }
  if(action==="edit") {
    await updatePendingBook(id,{status:"editing"});
    const {setState}=await import("./firebase.js");
    await setState("editingPendingId",id);
    await sendMessage(p.chatId,"أرسل البيانات بهذا الشكل في رسالة واحدة:\nاسم الكتاب | رقم الصف (1 أو 2 أو 3)");
    await answerCallbackQuery(q.id,"أرسل الاسم والصف في رسالة واحدة."); return;
  }
  await answerCallbackQuery(q.id);
}
async function handleEdit(message) {
  if(String(message.from?.id||"")!==ADMIN || !message.text) return false;
  const snap=await import("./firebase.js");
  // Find the most recently edited pending item belonging to this operator.
  const {getState}=snap;
  const editId=await getState("editingPendingId",null);
  if(!editId) return false;
  const p=await getPendingBook(editId);
  if(!p || p.status!=="editing") { await snap.setState("editingPendingId",null); return false; }
  const parts=message.text.split("|").map(s=>s.trim());
  const grade=Number(parts.at(-1));
  if(parts.length<2 || ![1,2,3].includes(grade)) {
    await sendMessage(message.chat.id,"صيغة غير صحيحة. مثال: كتاب الأحياء | 2"); return true;
  }
  const name=parts.slice(0,-1).join(" | ");
  await updatePendingBook(editId,{book_name:name,book_type:grade,status:"awaiting_approval"});
  await snap.setState("editingPendingId",null);
  const caption=`📚 ${name}\nالصف: ${GRADE_NAMES[grade]}\nأعد مراجعة البيانات ثم وافق على الرفع.`;
  await editMessageCaption(p.chatId,p.previewMessageId,caption,{reply_markup:keyboard(editId)});
  await sendMessage(message.chat.id,"تم تحديث البيانات.");
  return true;
}
export async function runBot() {
  if(!ADMIN || !process.env.TELEGRAM_BOT_TOKEN) throw new Error("Set ADMIN_TELEGRAM_ID and TELEGRAM_BOT_TOKEN.");
  const raw = process.env.TELEGRAM_UPDATE_JSON;
  if (!raw || raw === "null") {
    console.log("No Telegram update payload. Use a Telegram webhook dispatch or run the workflow with an update payload.");
    return;
  }

  const update = JSON.parse(raw);
  if (!Number.isInteger(update.update_id)) throw new Error("Invalid TELEGRAM_UPDATE_JSON: missing update_id.");
  const claimed = await claimWebhookUpdate(update.update_id);
  if (!claimed) {
    console.log(`Duplicate Telegram update ignored: ${update.update_id}`);
    return;
  }

  try {
    const me=await telegramApi("getMe");
    if(!me.username) throw new Error("Could not resolve bot username.");
    process.env.BOT_USERNAME=me.username;

    if(update.callback_query) {
      await handleCallback(update.callback_query);
    } else if(update.message) {
      if(String(update.message.from?.id||"")!==ADMIN) {
        if(update.message.chat?.id) await sendMessage(update.message.chat.id,"هذا البوت خاص بالمشرف.");
      } else if(await handleEdit(update.message)) {
        // edit flow handled
      } else if(getDocument(update.message)) {
        await receiveDocument(update.message);
        await preparePreview(update.message);
      } else if(update.message.text==="/start") {
        await sendMessage(update.message.chat.id,"أرسل ملف PDF إلى البوت لإعداد معاينة قبل الموافقة على رفعه.");
      }
    }
    await finishWebhookUpdate(update.update_id, "completed");
    console.log(`Processed Telegram update ${update.update_id}.`);
  } catch (error) {
    await finishWebhookUpdate(update.update_id, "failed", String(error).slice(0, 1000));
    throw error;
  }
}
