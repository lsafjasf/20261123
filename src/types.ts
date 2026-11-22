// Shared domain types. No runtime imports so this module works in Node and browsers.

export type CategoryId =
  | 'location'
  | 'device'
  | 'chat-thumbnail'
  | 'edit-history';

export type Confidence = 'confirmed' | 'review';

export type Risk =
  | 'container-only'
  | 'container-nonstandard'
  | 'breaks-timing'
  | 'out-of-scope';

export interface Category {
  id: CategoryId;
  label: string;
  description: string;
}

export const CATEGORIES: readonly Category[] = [
  {
    id: 'location',
    label: '拍摄地点',
    description: 'GPS 坐标、地名、地点标签，以及含定位信息的 XMP 数据包',
  },
  {
    id: 'device',
    label: '设备型号',
    description: '手机/相机厂商、型号、操作系统、软件版本、序列号等设备标识',
  },
  {
    id: 'chat-thumbnail',
    label: '聊天软件缩略图',
    description: '封面/缩略图（covr）及 IM 厂商写入的预览图与缓存块',
  },
  {
    id: 'edit-history',
    label: '旧剪辑记录',
    description: 'XMP 编辑历史、剪辑软件信息、工程标识、非标准编辑记录',
  },
];

export interface Finding {
  /** Stable structural path, e.g. /moov[0]/udta[0]/meta[0]/ilst[0]/©xyz[0] */
  path: string;
  boxType: string;
  /** Parsed four-char key for ilst entries, uuid string for uuid boxes */
  key?: string;
  /** Byte range of the whole removable box [start, end) */
  start: number;
  end: number;
  size: number;
  category: CategoryId;
  confidence: Confidence;
  risk: Risk;
  /** Human readable reason / evidence, may include truncated value */
  reason: string;
  /** Preview of the payload (text only, truncated) */
  preview?: string;
}

export interface BoxNode {
  type: string;
  start: number;
  headerSize: number;
  contentStart: number;
  end: number;
  size: number;
  /** For uuid boxes: 16-byte hex */
  uuid?: string;
  /** For FullBox: version + flags */
  version?: number;
  flags?: number;
  /** Whether the content starts with a full-box version/flags header */
  fullBox: boolean;
  /** Structural path of this node */
  path: string;
  children?: BoxNode[];
}

export interface SampleDigest {
  trackId: number;
  handler: string;
  codec: string;
  sampleCount: number;
  /** SHA-256 over the concatenation of every sample's raw bytes */
  samplesHash: string;
  /** Per-sample SHA-256, only when requested (can be large) */
  perSample?: { index: number; offset: number; size: number; sha256: string }[];
}

export interface MdatDigest {
  start: number;
  end: number;
  size: number;
  /** SHA-256 over the complete mdat payload (all codecs together) */
  payloadHash: string;
}

export interface HashManifest {
  version: 1;
  file: string;
  fileSize: number;
  sha256At: string;
  mdats: MdatDigest[];
  tracks: SampleDigest[];
}

export interface SidecarWarning {
  path: string;
  kind:
    | 'xmp-sidecar'
    | 'google-takeout-json'
    | 'appledouble'
    | 'thumbnail-cache'
    | 'generic-metadata'
    | 'same-basename';
  risk: 'high' | 'medium' | 'review';
  note: string;
}

export interface InspectReport {
  file: string;
  fileSize: number;
  brand: string;
  findings: Finding[];
  sidecars: SidecarWarning[];
  notes: string[];
}

export interface CleanResult {
  input: string;
  output: string;
  removed: Finding[];
  keptForReview: Finding[];
  rewroteContainer: boolean;
  reencoded: false;
  freeSpaceBytes: number;
  beforeManifest: HashManifest;
  afterManifest: HashManifest;
  hashMatch: boolean;
  sidecars: SidecarWarning[];
  notes: string[];
}
