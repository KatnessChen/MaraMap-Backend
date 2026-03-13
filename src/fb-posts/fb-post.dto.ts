export class MarathonMetadataDto {
  race_name: string | null;
  country: string | null;
  city: string | null;
  temperature: string | null;
  humidity: string | null;
  participants: Array<{
    name: 'Davis' | 'Rose';
    distance: string | null;
    finish_time: string | null;
    pace: string | null;
    race_count: number | null;
    status: string | null;
  }>;
}

export class FbPostDto {
  id: string;
  user_id: string;
  fb_timestamp: number;
  event_date: string;
  title: string;
  content: string;
  category: '馬拉松' | '旅遊' | '跑步訓練' | '日常生活';
  tags: string[];
  is_hidden: boolean;
  metadata: MarathonMetadataDto | null;
  media: Array<{
    uri: string;
    type: 'photo' | 'video';
    lat: number | null;
    lng: number | null;
    taken_at: number;
  }>;
  created_at: string;
}
