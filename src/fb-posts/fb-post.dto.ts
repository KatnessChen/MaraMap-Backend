export class FbPostDto {
  user_id: string; // The owner of the post
  fb_timestamp: number;
  event_date: string;
  title: string;
  content: string;
  category: '馬拉松' | '旅遊' | '跑步訓練' | '日常生活';
  tags: string[];
  media: Array<{
    uri: string;
    type: 'photo' | 'video';
    lat: number | null;
    lng: number | null;
    taken_at: number;
  }>;
}
