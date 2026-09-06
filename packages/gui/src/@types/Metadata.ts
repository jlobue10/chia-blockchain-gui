type Metadata = {
  attributes?: {
    trait_type: string;
    value: string;
  }[];
  collection?: {
    name: string;
    id: string;
    attributes: {
      trait_type: string;
      value: string;
    }[];
  };
  description?: string;
  image?: string;
  format?: string;
  name?: string;
  // CHIP-0007: a boolean, a string naming the kind of sensitive content, or a list of such strings
  sensitive_content?: boolean | string | string[];
  minting_tool?: string;
  preview_video_uris?: string[];
  preview_video_hash?: string;
  preview_image_uris?: string[];
  preview_image_hash?: string;
};

export default Metadata;
