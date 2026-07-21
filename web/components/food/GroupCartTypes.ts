export type GroupMember = {
  userId: string;
  name: string;
  subtotalPaise: number;
  isYou: boolean;
};

export type GroupItem = {
  id: string;
  userId: string;
  memberName: string;
  dishId: string;
  name: string;
  pricePaise: number;
  qty: number;
  isYou: boolean;
};

export type GroupRide = {
  pickup: string;
  drop: string;
  displayName: string;
  vehicle: string;
  seats: number;
};

export type GroupCart = {
  id: string;
  code: string;
  domain: "food" | "ride";
  platform: string;
  status: "open" | "locked" | "ordered" | "cancelled";
  orderId: string | null;
  isHost: boolean;
  ride: GroupRide | null;
  totalPaise: number;
  equalSplitPaise: number;
  members: GroupMember[];
  items: GroupItem[];
};

export type GroupShare = {
  userId: string;
  name: string;
  sharePaise: number;
  isHost: boolean;
  upiLink: string | null;
};
