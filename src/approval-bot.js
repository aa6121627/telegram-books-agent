import fs from "node:fs/promises";
import path from "node:path";
import {
  getUpdates, sendMessage, sendPhotoFile, editMessageText,
  answerCallbackQuery, telegramApi
} from "./bot-api.js";
import {
  getBotUpdateOffset, setBotUpdateOffset, savePendingBook,
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
function detectGrade(name) {
  const s=normalizeDigits(name).replace(/[أإآ]/g,"ا").replace(/ى/g,"ي").toLowerCase();
  if(/الثالث\s+الثانوي|الصف\s+الثالث|(?:^|\D)3\s*ث/.test(s)) return 3;
  if(/الثاني\s+الثانوي|الصف\s+الثاني|(?:^|\D)2\s*ث/.test(s)) return 2;
  if(/الاول\s+الثانوي|الصف\s+الاول|(?:^|\D)1\s*ث/.test(s)) return 1;
  return 0;
}
function cleanName(name) {
  return safeName(name).replace(/\.[^.]+$/,"").replace(/الصف\s+(الاول|الثاني|الثالث)\s+الثانوي/g," ")
    .replace(/(الاول|الثاني|الثالث)\s+الثانوي/g," ").replace(/(?:^|\s)[123]\s*ث(?:انوي)?(?=\s|$)/g," ")
    .replace(/\s+/g," ").trim();
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
async function findMtprotoMessage(client, botUsername, id) {
  const entity=await client.getEntity(botUsername);
  for await (const m of client.iterMessages(entity,{limit:100})) {
    if(Number(m.id)===Number(id) && m.media?.document) return m;
  }
  throw new Error("لم أجد الملف في محادثة MTProto. تأكد أن TG_SESSION لحسابك نفسه الذي أرسل الملف إلى البوت، وأن الرسالة ما زالت موجودة.");
}
async function downloadSource(client, pending, dest) {
  const bot=process.env.BOT_USERNAME;
  if(!bot) throw new Error("Missing BOT_USERNAME secret (username without @).");
  const m=await findMtprotoMessage(client,bot,pending.sourceMessageId);
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
    originalName:doc.fileName, size:doc.size, book_name:cleanName(doc.fileName),
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
    await editMessageText(pending.chatId,pending.previewMessageId,"✅ تم اعتماد الكتاب ورفعه بنجاح.");
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
  await editMessageText(p.chatId,p.previewMessageId,caption,{reply_markup:keyboard(editId)});
  await sendMessage(message.chat.id,"تم تحديث البيانات.");
  return true;
}
export async function runBot() {
  if(!ADMIN || !process.env.TELEGRAM_BOT_TOKEN) throw new Error("Set ADMIN_TELEGRAM_ID and TELEGRAM_BOT_TOKEN.");
  const me=await telegramApi("getMe");
  if(!me.username) throw new Error("Could not resolve bot username.");
  process.env.BOT_USERNAME=me.username;
  await telegramApi("deleteWebhook",{drop_pending_updates:false});
  const offset=await getBotUpdateOffset();
  const updates=await getUpdates(offset,0);
  for(const u of updates) {
    if(u.callback_query) await handleCallback(u.callback_query);
    else if(u.message) {
      if(String(u.message.from?.id||"")!==ADMIN) {
        if(u.message.chat?.id) await sendMessage(u.message.chat.id,"هذا البوت خاص بالمشرف.");
      } else if(await handleEdit(u.message)) {
        // edit flow handled
      } else if(getDocument(u.message)) {
        await receiveDocument(u.message);
        await preparePreview(u.message);
      } else if(u.message.text==="/start") {
        await sendMessage(u.message.chat.id,"أرسل ملف PDF إلى البوت لإعداد معاينة قبل الموافقة على رفعه.");
      }
    }
    await setBotUpdateOffset(u.update_id+1);
  }
  console.log(`Processed ${updates.length} Telegram update(s).`);
}
