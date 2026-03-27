import { respondWithJSON } from "./json";
import { type ApiConfig } from "../config";
import { type BunRequest } from "bun";
import { randomBytes } from "crypto";
import { BadRequestError, NotFoundError, UserForbiddenError } from "./errors";
import { getBearerToken, validateJWT } from "../auth";
import { getVideo, updateVideo } from "../db/videos";
import { tmpdir } from "os";
import { unlink } from "fs/promises";
import path from "path";

export async function handlerUploadVideo(cfg: ApiConfig, req: BunRequest) {
  const { videoId } = req.params as { videoId?: string };
  if (!videoId) {
    throw new BadRequestError("Invalid video ID");
  }

  const token = getBearerToken(req.headers);
  const userID = validateJWT(token, cfg.jwtSecret);

  console.log("uploading video for video", videoId, "by user", userID);

  const metadata = getVideo(cfg.db, videoId);
  if (!metadata) {
    throw new NotFoundError("Couldn't find video");
  }
  if (metadata.userID !== userID) {
    throw new UserForbiddenError("You are not the owner of this video");
  }

  const parsedform = await req.formData();
  const video = parsedform.get("video");
  if (!(video instanceof File)) {
    throw new BadRequestError("Invalid video file");
  }

  const MAX_UPLOAD_SIZE = 1 << 30;
  if (video.size > MAX_UPLOAD_SIZE) {
    throw new BadRequestError("File size exceeds 1GB limit");
  }

  if (video.type !== "video/mp4") {
    throw new BadRequestError("Only MP4 videos are supported");
  }

  const tempPath = path.join(tmpdir(), `${videoId}.mp4`);
  await Bun.write(tempPath, video);
  let processedPath: string | null = null;
  try {
    processedPath = await processVideoForFastStart(tempPath);
    const aspectRatio = await getVideoAspectRatio(processedPath);
    const fileKey = `${aspectRatio}/${randomBytes(32).toString("hex")}.mp4`;
    const s3File = cfg.s3Client.file(fileKey);
    await s3File.write(await Bun.file(processedPath).arrayBuffer(), { type: video.type });

    metadata.videoURL = `${cfg.s3CfDistribution}/${fileKey}`;
    updateVideo(cfg.db, metadata);

    return respondWithJSON(200, metadata);
  } finally {
    await unlink(tempPath);
    if (processedPath) await unlink(processedPath);
  }
}

export async function getVideoAspectRatio(filePath: string) {
  const proc = Bun.spawn(["ffprobe", "-v", "error", "-select_streams", "v:0", 
    "-show_entries", "stream=width,height", "-of", "json", filePath]);
  const stdoutText = await new Response(proc.stdout).text();
  const stderrText = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    throw new Error(`ffprobe failed (exit ${exitCode}): ${stderrText}`);
  }

  const data = JSON.parse(stdoutText);
  const { width, height } = data.streams[0];
  const ratio = width / height;
  if (Math.floor(ratio * 9) === 16) return "landscape";
  if (Math.floor(ratio * 16) === 9) return "portrait";
  return "other";
}

export async function processVideoForFastStart(inputFilePath: string) {
  const outputfile = `${inputFilePath}.processed`;
  const proc = Bun.spawn(["ffmpeg", "-i", inputFilePath, "-movflags", "faststart", "-map_metadata",
    "0", "-codec", "copy", "-f", "mp4", outputfile]);
  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    throw new Error(`ffprobe failed (exit ${exitCode})`);
  }

  return outputfile;
}

