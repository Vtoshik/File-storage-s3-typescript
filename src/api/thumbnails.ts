import { getBearerToken, validateJWT } from "../auth";
import { respondWithJSON } from "./json";
import { getVideo, updateVideo } from "../db/videos";
import type { ApiConfig } from "../config";
import type { BunRequest } from "bun";
import { BadRequestError, NotFoundError, UserForbiddenError } from "./errors";
import path from "path";
import { randomBytes } from "crypto";


export async function handlerUploadThumbnail(cfg: ApiConfig, req: BunRequest) {
  const { videoId } = req.params as { videoId?: string };
  if (!videoId) {
    throw new BadRequestError("Invalid video ID");
  }

  const token = getBearerToken(req.headers);
  const userID = validateJWT(token, cfg.jwtSecret);

  console.log("uploading thumbnail for video", videoId, "by user", userID);

  const parsedform = await req.formData();
  const image = parsedform.get("thumbnail");
  if (!(image instanceof File)) {
    throw new BadRequestError("Invalid image File");
  }

  const MAX_UPLOAD_SIZE = 10 << 20;
  if (image.size > MAX_UPLOAD_SIZE) {
    throw new BadRequestError("File size exceeds 10MB limit");
  }

  const metadata = getVideo(cfg.db, videoId);
  if (!metadata) {
    throw new NotFoundError("Couldn't find video");
  }
  if (metadata.userID !== userID) {
    throw new UserForbiddenError("You are not the owner of this video");
  }

  const imageData = Buffer.from(await image.arrayBuffer());
  if (image.type !== 'image/jpeg' && image.type !== 'image/png'){
    throw new BadRequestError("File type is wrong");
  }

  const ext = image.type.split("/")[1];
  const fileName = randomBytes(32).toString("base64url");
  const filePath = path.join(cfg.assetsRoot, `${fileName}.${ext}`);
  Bun.write(filePath, imageData);

  const thumbnailURL = `http://localhost:${cfg.port}/assets/${fileName}.${ext}`;
  metadata.thumbnailURL = thumbnailURL;
  updateVideo(cfg.db, metadata);


  return respondWithJSON(200, metadata);
}
