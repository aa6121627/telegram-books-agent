import { google } from "googleapis";
import fs from "node:fs";

function getDrive() {
  const auth = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET
  );

  auth.setCredentials({
    refresh_token: process.env.GOOGLE_REFRESH_TOKEN
  });

  return google.drive({ version: "v3", auth });
}

export async function uploadToDrive(filePath, fileName, mimeType = "application/octet-stream") {
  const drive = getDrive();
  const folderId = process.env.GOOGLE_DRIVE_FOLDER_ID;

  const response = await drive.files.create({
    requestBody: {
      name: fileName,
      ...(folderId ? { parents: [folderId] } : {})
    },
    media: {
      mimeType,
      body: fs.createReadStream(filePath)
    },
    uploadType: "resumable",
    fields: "id,name,mimeType,size,webViewLink"
  });

  const file = response.data;

  await drive.permissions.create({
    fileId: file.id,
    requestBody: {
      type: "anyone",
      role: "reader"
    }
  });

  return {
    id: file.id,
    name: file.name,
    size: file.size,
    webViewLink: file.webViewLink || `https://drive.google.com/file/d/${file.id}/view`,
    downloadLink: `https://drive.google.com/uc?export=download&id=${file.id}`
  };
}
