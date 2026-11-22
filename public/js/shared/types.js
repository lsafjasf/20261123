                                   
                 
                    
                        
                      
                        
                           
 

                            
             
                
                
              
 

                                
                   
                   
                 
                     
                   
                        
                   
                                           
                     
 

                              
                
              
                    
                    
                     
                 
                     
                   
 

                            
                
                
              
                    
                       
                    
                     
                     
                   
                      
                       
 

                               
             
                
                         
                
              
                   
                     
                       
                       
                     
                   
                      
                    
 

                         
               
                 
                    
             
                    
                

                                  
             
                    
                
                
              
                   
                                            
                 
                 
 

                                   
                        
                
                
 

                                 
                          
                             
                       
                        
                             
                     
                       
                       
                     
                   
                      
                      
                        
                               
                    
                     
 

                                  
                   
                             
 

                           
                                                           
                                         
                                                        
                     
                      
                       

                            
                                                 
                                                                                                       
                                              
                                       

export const DEFAULT_SETTINGS                   = {
  target: -14,
  tolerance: 1,
  truePeakLimit: -1,
  peakWarning: -3,
  loudnessBurst: 8,
  silenceThreshold: -60
};

export const PRESETS                                                                                  = [
  {
    id: 'streaming',
    name: '流媒体交付',
    detail: '-14 LUFS / -1 dBTP',
    settings: { ...DEFAULT_SETTINGS }
  },
  {
    id: 'podcast',
    name: '播客 / 口播',
    detail: '-16 LUFS / -1 dBTP',
    settings: { ...DEFAULT_SETTINGS, target: -16, tolerance: 1 }
  },
  {
    id: 'broadcast',
    name: '广播 EBU R128',
    detail: '-23 LUFS / -1 dBTP',
    settings: { ...DEFAULT_SETTINGS, target: -23, tolerance: 1 }
  }
];

export function formatLufs(value        )         {
  return Number.isFinite(value) ? value.toFixed(1) : '—';
}

export function formatDb(value        )         {
  return Number.isFinite(value) ? `${value.toFixed(1)}` : '—';
}

export function formatTime(seconds        , withMillis = false)         {
  if (!Number.isFinite(seconds)) return '--:--';
  const safe = Math.max(0, seconds);
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const secs = Math.floor(safe % 60);
  const millis = Math.floor((safe % 1) * 1000);
  const base = hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
    : `${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  return withMillis ? `${base}.${String(millis).padStart(3, '0')}` : base;
}
