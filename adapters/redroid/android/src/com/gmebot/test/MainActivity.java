package com.gmebot.test;
import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.PowerManager;
import android.util.Log;
import com.gme.TMG.ITMGContext;
import com.gme.av.sig.AuthBuffer;
import org.json.JSONObject;
import java.io.*;
import java.net.ServerSocket;
import java.net.Socket;

public class MainActivity extends Activity {
  static final String TAG = "GMEBOT";
  static final int APPID = BuildConfig.GME_SDK_APP_ID;
  static final String KEY = BuildConfig.GME_SDK_KEY;
  int httpPort = 9099;   // derived per-instance in onCreate (see below)

  ITMGContext ctx; Handler main; PowerManager.WakeLock wake;
  volatile String status="idle", room=null, curFile=null, lastError=null;
  volatile int volume=100;
  volatile int roomType=0;
  volatile boolean inRoom=false, songFinished=false;
  volatile boolean inited=false;   // GME context Init done once per process
  // Debug: when on, GME plays the outgoing mix (mic + accompany) on the local
  // speaker so the owner can hear exactly what the room receives.
  volatile boolean loopback=false;
  // New rooms use the highest-fidelity GME profile by default. The Portal can
  // change it later through POST /room-quality.
  static final int DEFAULT_ROOM_TYPE = ITMGContext.ITMG_ROOM_TYPE_HIGHQUALITY;

  // GME requires a NUMERIC openId (a uint32-range id; YelloTalk's own gme_user_id
  // is such a number). A raw account UUID ("fc7f7c1e-cb5d-...") is rejected by
  // Init with 1004 AV_ERR_INVALID_ARGUMENT, which then makes EnterRoom fail with
  // 1101 "AVContext did not start". Map any non-numeric id to a stable positive
  // 31-bit number (FNV-1a) so the same account always gets the same GME identity.
  // The SAME derived id must be used for Init and for genAuthBuffer or the auth
  // signature will not match the joining user.
  static String gmeOpenId(String raw){
    if(raw!=null && raw.matches("[0-9]{1,9}")) return raw;
    long h=2166136261L;
    if(raw!=null) for(int i=0;i<raw.length();i++){ h^=(raw.charAt(i)&0xFF); h=(h*16777619L)&0xFFFFFFFFL; }
    long v=h&0x7FFFFFFFL; if(v==0) v=1;
    return String.valueOf(v);
  }
  static String roomTypeName(int type){ return type==1?"fluency":type==2?"standard":type==3?"highquality":"unknown"; }
  static int parseRoomType(String value){
    if(value==null)return 0; value=value.toLowerCase();
    if(value.equals("fluency")||value.equals("1"))return 1;
    if(value.equals("standard")||value.equals("2"))return 2;
    if(value.equals("highquality")||value.equals("high-quality")||value.equals("3"))return 3;
    return 0;
  }

  @Override protected void onCreate(Bundle b){
    super.onCreate(b);
    // Each app copy (com.gmebot.botN, produced via aapt --rename-manifest-package)
    // derives a unique control port from the trailing digits of its package name,
    // so N independent GME clients run side by side. Base package -> 9099.
    try{
      java.util.regex.Matcher pkm=java.util.regex.Pattern.compile("(\\d+)$").matcher(getPackageName());
      if(pkm.find()) httpPort=9099+Integer.parseInt(pkm.group(1));
    }catch(Throwable t){ Log.e(TAG,"port",t); }
    PowerManager pm=(PowerManager)getSystemService(Context.POWER_SERVICE);
    wake=pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK,"gmebot:wl"); wake.acquire();
    main=new Handler(Looper.getMainLooper());
    ctx=ITMGContext.GetInstance(getApplicationContext());
    ctx.SetTMGDelegate(new ITMGContext.ITMGDelegate(){
      public void OnEvent(ITMGContext.ITMG_MAIN_EVENT_TYPE type, Intent data){
        int result=data!=null?data.getIntExtra("result",-999):-999;
        if(type==ITMGContext.ITMG_MAIN_EVENT_TYPE.ITMG_MAIN_EVENT_TYPE_ENTER_ROOM){
          Log.i(TAG,"ENTER_ROOM result="+result);
          if(result==0){inRoom=true;status="joined";lastError=null;
            // Upgrade the room codec for music: fluency (type 1) = 16kHz mono = muffled.
            // HIGHQUALITY may need Tencent to enable it for the app; rc/logs tell us.
            try{ int rc=ctx.GetRoom().ChangeRoomType(DEFAULT_ROOM_TYPE); roomType=ctx.GetRoom().GetRoomType(); Log.i(TAG,"ChangeRoomType(HQ) rc="+rc+" curType="+roomType); }catch(Throwable t){ Log.e(TAG,"chgroom",t); }
          } else {lastError="enter="+result;status="error";}
        } else if(type==ITMGContext.ITMG_MAIN_EVENT_TYPE.ITMG_MAIN_EVENT_TYPE_CHANGE_ROOM_TYPE){ try{ roomType=ctx.GetRoom().GetRoomType(); }catch(Throwable t){} Log.i(TAG,"CHANGE_ROOM_TYPE curType="+roomType); }
        else if(type==ITMGContext.ITMG_MAIN_EVENT_TYPE.ITMG_MAIN_EVENT_TYPE_EXIT_ROOM){inRoom=false;roomType=0;status="idle";}
        else if(type==ITMGContext.ITMG_MAIN_EVENT_TYPE.ITMG_MAIN_EVENT_TYPE_ACCOMPANY_FINISH){Log.i(TAG,"ACCOMPANY_FINISH");songFinished=true;status="joined";}
      }
    });
    main.post(new Runnable(){public void run(){ if(ctx!=null) ctx.Poll(); main.postDelayed(this,100);} });
    new Thread(new Runnable(){public void run(){ httpServer(); }},"http").start();
    Log.i(TAG,"GmeBot ready pkg="+getPackageName()+" http="+httpPort+" sdk="+ctx.GetSDKVersion());
  }

  interface Op{ void run(); }
  void onMain(final Op op){
    final Object lk=new Object(); final boolean[] d={false};
    main.post(new Runnable(){public void run(){ try{op.run();}catch(Throwable t){Log.e(TAG,"op",t);} synchronized(lk){d[0]=true;lk.notifyAll();} }});
    synchronized(lk){ if(!d[0]){ try{lk.wait(6000);}catch(InterruptedException e){} } }
  }

  void httpServer(){
    try{ ServerSocket ss=new ServerSocket(httpPort);
      while(true){ final Socket s=ss.accept(); new Thread(new Runnable(){public void run(){ handle(s);} }).start(); }
    }catch(Exception e){ Log.e(TAG,"httpsrv",e); }
  }

  void handle(Socket s){
    try{
      BufferedReader in=new BufferedReader(new InputStreamReader(s.getInputStream()));
      String line=in.readLine(); if(line==null){s.close();return;}
      String[] p=line.split(" "); String method=p[0], path=p.length>1?p[1]:"/";
      int clen=0; String h;
      while((h=in.readLine())!=null && !h.isEmpty()){ if(h.toLowerCase().startsWith("content-length:")) clen=Integer.parseInt(h.substring(h.indexOf(':')+1).trim()); }
      char[] body=new char[clen]; int off=0; while(clen>0 && off<clen){ int r=in.read(body,off,clen-off); if(r<0)break; off+=r; }
      JSONObject req=new JSONObject(); try{ if(clen>0) req=new JSONObject(new String(body,0,off)); }catch(Exception e){}
      String resp=route(path,req);
      OutputStream out=s.getOutputStream();
      byte[] rb=resp.getBytes("UTF-8");
      out.write(("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: "+rb.length+"\r\nConnection: close\r\n\r\n").getBytes());
      out.write(rb); out.flush(); s.close();
    }catch(Exception e){ try{s.close();}catch(Exception e2){} }
  }
  String route(String path, JSONObject req) throws Exception {
    JSONObject j=new JSONObject();
    if(path.startsWith("/status")){
      j.put("status",status);j.put("inRoom",inRoom);j.put("room",room);j.put("currentFile",curFile);j.put("volume",volume);j.put("roomType",roomType);j.put("roomQuality",roomTypeName(roomType));j.put("songFinished",songFinished);j.put("error",lastError);return j.toString();
    }
    if(path.startsWith("/join")){
      room=req.optString("room",""); final String user=req.optString("user","0"); final String uuid=req.optString("uuid",user);
      final String oid=gmeOpenId(uuid);   // GME-valid numeric id used for BOTH Init and genAuthBuffer
      status="joining";inRoom=false;roomType=0;lastError=null;
      // GME's context start is ASYNCHRONOUS: Init() dispatches a StartTask to a
      // worker thread (Start returns 1004) that only reaches the "started" state
      // once the Poll loop on the main looper has driven it for a few cycles.
      // Calling EnterRoom in the same main-thread tick as Init races that start
      // and always fails with 1101 "AVContext did not start". So: Init once,
      // then retry EnterRoom on later ticks, yielding the main thread between
      // attempts so Poll() can bring the context up.
      if(!inited){ onMain(new Op(){public void run(){ int rc=ctx.Init(String.valueOf(APPID),oid); Log.i(TAG,"Init rc="+rc); }}); inited=true; }
      for(int attempt=0; attempt<15 && !inRoom; attempt++){
        Thread.sleep(600);   // let Poll() cycles advance the context start
        lastError=null;
        onMain(new Op(){public void run(){ byte[] a=AuthBuffer.getInstance().genAuthBuffer(APPID,room,oid,KEY); int rc=ctx.EnterRoom(room,DEFAULT_ROOM_TYPE,a); Log.i(TAG,"EnterRoom rc="+rc+" attempt="+room); }});
        long t0=System.currentTimeMillis(); while(!inRoom && lastError==null && System.currentTimeMillis()-t0<2500){ Thread.sleep(120); }
        if(inRoom) break;
        if(lastError!=null && lastError.indexOf("1101")<0) break;   // a real error, stop retrying
      }
      j.put("ok",inRoom);j.put("inRoom",inRoom);j.put("status",status);j.put("error",lastError);return j.toString();
    }
    if(path.startsWith("/play")){
      final String file=req.optString("file",""); final boolean loop=req.optBoolean("loop",false);
      curFile=file;songFinished=false;
      final int[] rc={-999};
      onMain(new Op(){public void run(){
        ctx.GetAudioCtrl().EnableAudioCaptureDevice(true); ctx.GetAudioCtrl().EnableAudioSend(true);
        ctx.GetAudioCtrl().SetMicVolume(0); ctx.GetAudioCtrl().EnableSpeaker(loopback); ctx.GetAudioCtrl().EnableLoopBack(loopback);
        int stopRc=ctx.GetAudioEffectCtrl().StopAccompany(0);
        rc[0]=ctx.GetAudioEffectCtrl().StartAccompany(file,true,loop?-1:1);
        if(rc[0]!=0){ int s2=ctx.GetAudioEffectCtrl().StopAccompany(0); rc[0]=ctx.GetAudioEffectCtrl().StartAccompany(file,true,loop?-1:1); Log.i(TAG,"PLAY-RETRY stop2="+s2+" start2="+rc[0]); }
        ctx.GetAudioEffectCtrl().SetAccompanyVolume(volume);
        Log.i(TAG,"PLAY pkg="+getPackageName()+" room="+room+" file="+file+" stopRc="+stopRc+" startRc="+rc[0]);
      }});
      status="playing"; j.put("ok",rc[0]==0);j.put("startRc",rc[0]);j.put("file",file);return j.toString();
    }
    if(path.startsWith("/stop")){ onMain(new Op(){public void run(){ ctx.GetAudioEffectCtrl().StopAccompany(0);} }); status=inRoom?"joined":"idle";curFile=null; j.put("ok",true);return j.toString(); }
    if(path.startsWith("/pause")){ onMain(new Op(){public void run(){ ctx.GetAudioEffectCtrl().PauseAccompany();} }); status="paused"; j.put("ok",true);return j.toString(); }
    if(path.startsWith("/resume")){ onMain(new Op(){public void run(){ ctx.GetAudioEffectCtrl().ResumeAccompany();} }); status="playing"; j.put("ok",true);return j.toString(); }
    if(path.startsWith("/volume")){ volume=req.optInt("vol",100); onMain(new Op(){public void run(){ ctx.GetAudioEffectCtrl().SetAccompanyVolume(volume);} }); j.put("ok",true);j.put("volume",volume);return j.toString(); }
    if(path.startsWith("/room-quality")){
      final int requested=parseRoomType(req.optString("quality",""));
      if(requested==0){ j.put("success",false);j.put("error","quality must be fluency, standard, or highquality");return j.toString(); }
      if(!inRoom){ j.put("success",false);j.put("error","Not in GME room");return j.toString(); }
      final int[] rc={-999};
      onMain(new Op(){public void run(){ try{
        if(requested==1) rc[0]=ctx.GetRoom().ChangeRoomType(ITMGContext.ITMG_ROOM_TYPE_FLUENCY);
        else if(requested==2) rc[0]=ctx.GetRoom().ChangeRoomType(ITMGContext.ITMG_ROOM_TYPE_STANDARD);
        else rc[0]=ctx.GetRoom().ChangeRoomType(ITMGContext.ITMG_ROOM_TYPE_HIGHQUALITY);
        roomType=ctx.GetRoom().GetRoomType();
      }catch(Throwable t){ lastError="ChangeRoomType: "+t; rc[0]=-1; } }});
      j.put("success",rc[0]==0);j.put("roomType",roomType);j.put("roomQuality",roomTypeName(roomType));
      if(rc[0]!=0)j.put("error","ChangeRoomType failed: "+rc[0]);
      return j.toString();
    }
    if(path.startsWith("/loopback")){
      loopback=req.optBoolean("on",false);
      final int[] rc={-999,-999};
      onMain(new Op(){public void run(){ rc[0]=ctx.GetAudioCtrl().EnableSpeaker(loopback); rc[1]=ctx.GetAudioCtrl().EnableLoopBack(loopback); Log.i(TAG,"LOOPBACK on="+loopback+" speakerRc="+rc[0]+" loopbackRc="+rc[1]); }});
      j.put("ok",rc[0]==0&&rc[1]==0);j.put("loopback",loopback);j.put("speakerRc",rc[0]);j.put("loopbackRc",rc[1]);return j.toString();
    }
    if(path.startsWith("/levels")){
      final int[] lv={-1,-1,-1};
      onMain(new Op(){public void run(){ lv[0]=ctx.GetAudioCtrl().GetSendStreamLevel(); lv[1]=ctx.GetAudioCtrl().GetMicLevel(); lv[2]=ctx.GetAudioCtrl().GetSpeakerLevel(); }});
      j.put("sendStreamLevel",lv[0]);j.put("micLevel",lv[1]);j.put("speakerLevel",lv[2]);j.put("loopback",loopback);j.put("status",status);return j.toString();
    }
    if(path.startsWith("/leave")){ onMain(new Op(){public void run(){ try{ctx.GetAudioEffectCtrl().StopAccompany(0);}catch(Throwable t){} ctx.ExitRoom();} }); inRoom=false;roomType=0;status="idle";room=null;curFile=null; j.put("ok",true);return j.toString(); }
    j.put("error","unknown"); return j.toString();
  }
}
