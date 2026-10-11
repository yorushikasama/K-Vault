const assert = require('assert');

const {
  isWatermarkedFormat,
  pickBestFormat,
  buildVariants,
} = require('../server/lib/services/media-resolve-service');

/**
 * 抖音水印回归。
 *
 * 实测（2026-10-11，真实分享链接 https://v.douyin.com/MBWZgG2rNWE/）：
 * 同一个作品的详情接口给出两路视频——
 *   play_addr（无水印）  720p 最大 741 KiB，format_note "Playback video"
 *   download_addr（水印）720p 1.39 MiB，format_note "Download video, watermarked"
 * 带水印那路因为码率高而文件更大，而挑流规则原本纯按体积取最大，
 * 于是默认下载与清晰度选择器全都落在水印版上。
 *
 * 这里钉住：水印标记必须压过体积，两处挑流都要选无水印源。
 */

// 与线上 --list-formats 同构的最小取样。
const PLAYBACK_720_LOW = {
  format_id: 'bytevc1_720p_327884-0',
  format_note: 'Playback video (API)',
  vcodec: 'h265', acodec: 'aac', height: 720, width: 720,
  filesize: 301_936,
};
const PLAYBACK_720_HIGH = {
  format_id: 'bytevc1_720p_824300-0',
  format_note: 'Playback video (API)',
  vcodec: 'h265', acodec: 'aac', height: 720, width: 720,
  filesize: 759_081,
};
const WATERMARKED_720 = {
  format_id: 'download_addr-0',
  format_note: 'Download video, watermarked (API)',
  vcodec: 'h264', acodec: 'aac', height: 720, width: 720,
  filesize: 1_457_641,
};

describe('douyin watermark is not selected', function () {
  it('recognises the watermarked format by note', function () {
    assert.strictEqual(isWatermarkedFormat(WATERMARKED_720), true);
    assert.strictEqual(isWatermarkedFormat(PLAYBACK_720_HIGH), false);
  });

  it('recognises it by format_id when the note is missing', function () {
    // 老版本 yt-dlp 或字段裁剪后只剩 format_id 也要认得出。
    assert.strictEqual(isWatermarkedFormat({ format_id: 'download_addr-2' }), true);
    assert.strictEqual(isWatermarkedFormat({ format_id: 'download-addr-1' }), true);
    assert.strictEqual(isWatermarkedFormat({ format_id: 'bytevc1_720p_1' }), false);
  });

  it('pickBestFormat takes the smaller non-watermarked stream', function () {
    const best = pickBestFormat([WATERMARKED_720, PLAYBACK_720_LOW, PLAYBACK_720_HIGH]);
    assert.strictEqual(best.format_id, 'bytevc1_720p_824300-0',
      '挑流选中了带水印的源：体积规则压过了水印规则');
  });

  it('pickBestFormat still prefers the largest among clean streams', function () {
    const best = pickBestFormat([PLAYBACK_720_LOW, PLAYBACK_720_HIGH]);
    assert.strictEqual(best.format_id, 'bytevc1_720p_824300-0');
  });

  it('buildVariants keeps the clean stream for each resolution', function () {
    const variants = buildVariants([WATERMARKED_720, PLAYBACK_720_LOW, PLAYBACK_720_HIGH]);
    const at720 = variants.find((v) => v.height === 720);
    assert.ok(at720, '720p 档位消失了');
    assert.strictEqual(at720.formatId, 'bytevc1_720p_824300-0',
      '清晰度选择器给出的 720p 是带水印的那路');
  });

  it('keeps the watermarked stream only when nothing else exists', function () {
    // 兜底：平台只给水印源时仍然要能用，不能因为过滤把视频变成不可下载。
    const best = pickBestFormat([WATERMARKED_720]);
    assert.strictEqual(best.format_id, 'download_addr-0');
    const variants = buildVariants([WATERMARKED_720]);
    assert.strictEqual(variants.length, 1);
  });
});
