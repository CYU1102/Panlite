const fs = require('fs');
const path = require('path');

// 创建一个简单的 256x256 PNG 图标
// PNG 文件头和 IHDR chunk
const width = 256;
const height = 256;

// 创建一个简单的蓝色方块图标
function createPNG() {
  // PNG 签名
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  // IHDR chunk
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);  // width
  ihdrData.writeUInt32BE(height, 4); // height
  ihdrData.writeUInt8(8, 8);         // bit depth
  ihdrData.writeUInt8(2, 9);         // color type (RGB)
  ihdrData.writeUInt8(0, 10);        // compression
  ihdrData.writeUInt8(0, 11);        // filter
  ihdrData.writeUInt8(0, 12);        // interlace

  const ihdrChunk = createChunk('IHDR', ihdrData);

  // 创建图像数据（简单的蓝色渐变）
  const rawData = [];
  for (let y = 0; y < height; y++) {
    rawData.push(0); // filter byte
    for (let x = 0; x < width; x++) {
      // 创建一个渐变效果
      const r = 74;   // #4A90D9
      const g = 144;
      const b = 217;

      // 添加一些简单的图案
      const centerX = width / 2;
      const centerY = height / 2;
      const dist = Math.sqrt((x - centerX) ** 2 + (y - centerY) ** 2);

      if (dist < 100) {
        // 内部区域 - 白色
        rawData.push(255);
        rawData.push(255);
        rawData.push(255);
      } else if (dist < 120) {
        // 边框 - 深蓝色
        rawData.push(53);
        rawData.push(122);
        rawData.push(189);
      } else {
        // 外部 - 蓝色渐变
        const factor = 1 - (dist - 120) / 136;
        rawData.push(Math.floor(r * factor));
        rawData.push(Math.floor(g * factor));
        rawData.push(Math.floor(b * factor));
      }
    }
  }

  const rawBuffer = Buffer.from(rawData);

  // 压缩数据（简单存储，不压缩）
  const zlib = require('zlib');
  const compressedData = zlib.deflateSync(rawBuffer);

  const idatChunk = createChunk('IDAT', compressedData);

  // IEND chunk
  const iendChunk = createChunk('IEND', Buffer.alloc(0));

  // 组合所有 chunk
  return Buffer.concat([signature, ihdrChunk, idatChunk, iendChunk]);
}

function createChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);

  const typeBuffer = Buffer.from(type, 'ascii');
  const crcData = Buffer.concat([typeBuffer, data]);

  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(crcData), 0);

  return Buffer.concat([length, typeBuffer, data, crc]);
}

function crc32(buf) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    crc = crc ^ buf[i];
    for (let j = 0; j < 8; j++) {
      if (crc & 1) {
        crc = (crc >>> 1) ^ 0xEDB88320;
      } else {
        crc = crc >>> 1;
      }
    }
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

// 生成并保存 PNG
const pngData = createPNG();
const outputPath = path.join(__dirname, '..', 'build', 'icon.png');
fs.writeFileSync(outputPath, pngData);
console.log(`Icon created: ${outputPath}`);
console.log(`File size: ${pngData.length} bytes`);
